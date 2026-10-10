import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage, BetaToolRunnerParams } from "@anthropic-ai/sdk/resources/beta/messages";
import { z } from "zod";
import type { Department, Employee, Task } from "../shared/types";
import { blockActivity, finalText, modelParams, shorten } from "./claude";
import { WORKER_MAX_ITERATIONS, departmentMemoryDir, employeeMemoryDir } from "./config";
import { listDrive, readDriveFile, writeDepartmentFile } from "./drive";
import { commandsBrief, runApprovedCommand } from "./commands";
import { employeeIntro } from "./employees";
import { taskBrief } from "./taskBrief";
import { createMemoryTool } from "./memory";
import { getClient, getSettings } from "./settings";
import { changed } from "./store";

// A worker is one Claude agent loop working on one task. It does the work for real: its
// deliverables are files on the company drive, and its final reply is the summary the boss sees.

const ACTIVITY_LINES = 8;

function departmentSystemPrompt(department: Department, companyName: string, employee?: Employee) {
  const memory = employee
    ? `- Your memory has two folders. /memories/team/ is your department's shared notes: the boss's preferences and lessons for everyone in ${department.name}. /memories/me/ is yours alone: what you know about your area, and a log of the tasks you have done. Check both before you start, and build on your earlier work. Before you finish, add this task to your log (date, task, what you made and where), update what you know about your area, and put anything the whole department should know in /memories/team/. Keep notes short and current. Never store secrets.`
    : `- Your department keeps a memory directory. Check it before you start for preferences and lessons from earlier tasks. Before you finish, record anything that will help future tasks in this department (the boss's preferences, style decisions, recurring facts). Never store secrets.`;
  return `You work in the ${department.name} department of ${companyName}, a company in Siverse, an office simulator where a real person is the boss and the work is real. The office manager hands you tasks from the boss.

Department focus: ${department.genre}
Standing instructions for this department:
${department.description || "(none yet)"}
${employee ? `\n${employeeIntro(employee, department)}\n` : ""}
How to work:
- Do the task for real. Your deliverables are files you save with write_file; that is what the boss reads. Use Markdown (.md) for documents and the right extension for code or data. If a task produces several files, put them in a folder named after the task.
- You can read anything on the company drive with list_files and read_file, including other departments' work.
${memory}
- ${department.webAccess ? "You can search and read the web. Cite your sources in the deliverable." : "You have no internet access. Work from your own knowledge and the company drive, and flag facts that may be out of date."}
- Nobody can answer questions while you work. Make sensible assumptions and note them in the deliverable.
- When you're done, reply with a 2-4 sentence summary for the boss: what you made and where it is.${commandsBrief(department) ? `\n\n${commandsBrief(department)}` : ""}`;
}

function describeTool(name: string, input: unknown): string | null {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "write_file":
      return `📝 Writing ${args.path ?? "a file"}`;
    case "read_file":
      return `📖 Reading ${args.path ?? "a file"}`;
    case "list_files":
      return "🗂️ Looking through the drive";
    case "run_command":
      return `▶ Asking to run ${args.name ?? "a command"}`;
    case "memory":
      return args.command === "view" ? "🧠 Checking the department notes" : "🧠 Updating the department notes";
    default:
      return null;
  }
}

function pushActivity(task: Task, line: string) {
  task.activity.push(shorten(line));
  if (task.activity.length > ACTIVITY_LINES) task.activity.splice(0, task.activity.length - ACTIVITY_LINES);
  changed();
}

function workerTools(task: Task, department: Department, signal: AbortSignal, employee?: Employee) {
  const tools: BetaToolRunnerParams["tools"] = [
    // Deliverables can be long, so stream the tool input as it is generated. The zod schema
    // still validates the full input before run() is called.
    Object.assign(
      betaZodTool({
        name: "write_file",
        description: `Save a deliverable to the company drive, inside the ${department.name} folder. Overwrites an existing file with the same path.`,
        inputSchema: z.object({
          path: z.string().describe('Path inside your department folder, e.g. "launch-plan/announcement.md"'),
          content: z.string().describe("The full text content of the file"),
        }),
        run: ({ path, content }) => {
          const drivePath = writeDepartmentFile(department.id, path, content);
          if (!task.outputs.includes(drivePath)) task.outputs.push(drivePath);
          changed();
          return `Saved ${drivePath} (${content.length} characters).`;
        },
      }),
      { eager_input_streaming: true },
    ),
    betaZodTool({
      name: "read_file",
      description: "Read a text file from the company drive.",
      inputSchema: z.object({
        path: z.string().describe('Drive path, e.g. "research/market-scan.md"'),
      }),
      run: ({ path }) => readDriveFile(path),
    }),
    betaZodTool({
      name: "list_files",
      description: "List files on the company drive, optionally inside one folder.",
      inputSchema: z.object({
        folder: z.string().optional().describe('Folder to list, e.g. "marketing". Omit to list everything.'),
      }),
      run: ({ folder }) => listDrive(folder ?? "").join("\n") || "(no files yet)",
    }),
    createMemoryTool(
      employee
        ? { team: departmentMemoryDir(department.id), me: employeeMemoryDir(employee.id) }
        : departmentMemoryDir(department.id),
    ),
  ];
  if (commandsBrief(department)) {
    tools.push(
      betaZodTool({
        name: "run_command",
        description:
          "Run one of your department's approved commands (listed in your instructions). Some runs wait for the boss's OK first; this tool waits for their answer and then returns the command's output.",
        inputSchema: z.object({
          name: z.string().describe("The approved command's name"),
          args: z.array(z.string()).describe("Arguments, one per item. Empty for none."),
          reason: z.string().describe("One line for the boss: what this run does and why now"),
        }),
        run: ({ name, args, reason }) => runApprovedCommand(task, name, args, reason, signal),
      }),
    );
  }
  if (department.webAccess) {
    tools.push(
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
    );
  }
  return tools;
}

/** Runs the task to completion and returns the worker's summary for the boss. */
export async function runWorker(
  task: Task,
  department: Department,
  signal: AbortSignal,
  employee?: Employee,
): Promise<string> {
  const client = getClient();
  if (!client) throw new Error("No Claude API key is configured.");
  const { workerModel, companyName } = getSettings();

  pushActivity(task, `👋 ${task.workerName} sat down to work`);

  const runner = client.beta.messages.toolRunner(
    {
      ...modelParams(department.model ?? workerModel, department.effort ?? "medium"),
      max_tokens: 64000,
      stream: true,
      max_iterations: WORKER_MAX_ITERATIONS,
      cache_control: { type: "ephemeral" },
      system: departmentSystemPrompt(department, companyName, employee),
      tools: workerTools(task, department, signal, employee),
      messages: [
        {
          role: "user",
          content: `You are ${task.workerName}. ${taskBrief(task)}`,
        },
      ],
    },
    { signal },
  );

  let last: BetaMessage | undefined;
  for await (const stream of runner) {
    stream.on("contentBlock", (block) => {
      const line = blockActivity(block, describeTool);
      if (line) pushActivity(task, line);
    });
    last = await stream.finalMessage();

    task.usage.inputTokens += last.usage.input_tokens;
    task.usage.outputTokens += last.usage.output_tokens;
    task.usage.cacheReadTokens += last.usage.cache_read_input_tokens ?? 0;
    changed();

    // Never run the tools of a turn that was cut off or declined.
    if (last.stop_reason === "refusal") throw new Error("Claude declined this task.");
    if (last.stop_reason === "max_tokens") throw new Error("The worker ran out of room mid-step. Try a smaller task.");
  }

  if (last?.stop_reason === "tool_use") {
    throw new Error(`The worker hit the ${WORKER_MAX_ITERATIONS}-step limit before finishing. Try splitting the task.`);
  }
  const summary = finalText(last);
  pushActivity(task, "✅ Done");
  return summary || (task.outputs.length ? `Saved ${task.outputs.join(", ")}.` : "Finished.");
}

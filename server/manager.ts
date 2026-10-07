import fs from "node:fs";
import path from "node:path";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages";
import { z } from "zod";
import type { Department } from "../shared/types";
import { MAX_HEADCOUNT } from "../shared/types";
import { blockActivity, explainError, finalText, modelParams, shorten } from "./claude";
import { COMPANY_MEMORY_DIR, DATA_DIR, MANAGER_MAX_ITERATIONS, MAX_CONCURRENT_WORKERS } from "./config";
import { listDrive, readDriveFile } from "./drive";
import { createMemoryTool } from "./memory";
import {
  OfficeError,
  assignTask,
  cancelTask,
  closeDepartment,
  createDepartment,
  updateDepartment,
} from "./office";
import { getClient, getSettings } from "./settings";
import { addChat, changed, findDepartment, findTask, managerStatus, state } from "./store";

// The manager is the boss's chat partner: one long-running Claude conversation that turns
// instructions into departments and tasks. Its history is append-only and saved to disk, and it
// keeps lasting notes about the boss in its memory directory, which survives a "new day" reset.

const HISTORY_FILE = path.join(DATA_DIR, "manager-history.json");
let history: BetaMessageParam[] = [];

export function loadManagerHistory() {
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    history = [];
  }
}

function saveHistory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

export function startNewDay() {
  if (managerStatus.busy) throw new OfficeError("The manager is still busy. Try again in a moment.");
  history = [];
  saveHistory();
  addChat("system", "☀️ A new workday begins. The manager starts fresh but keeps their notes.", { tone: "info" });
}

function systemPrompt(companyName: string) {
  return `You are the office manager of ${companyName}, a company in Siverse, a 3D office simulator. The person chatting with you is the boss. The work is real: you turn the boss's instructions into an organisation that gets it done.

How the office works:
- Departments are teams that each focus on one genre of work (for example Marketing for copywriting and social posts, Engineering for code, Research for investigation and reports). Each has standing instructions and a headcount, which is how many of its tasks can be worked on at once.
- Every task goes to exactly one department. A worker picks it up, does the work, and saves deliverables to the company drive (one folder per department). Workers can't ask questions mid-task, so write self-contained briefs: the goal, audience, format, length, and anything the boss said that matters.
- Up to ${MAX_CONCURRENT_WORKERS} workers can be at their desks across the whole office; extra tasks wait in a queue.

How to act:
- Do what the boss asks with your tools instead of describing what you would do.
- Create a department when the boss asks for one, or when a request clearly needs one that doesn't exist yet, and say that you did.
- Send work to the best-fitting department. Split big requests into a few standalone tasks, across departments if needed.
- When the boss asks about results, read the task result or the files and report back briefly.
- Each boss message starts with an <office_status> block with the live state of the office. Trust it over earlier turns.
- Keep notes on the boss's lasting preferences and important company decisions in your memory directory. Never store secrets.
- Reply like a sharp, friendly chief of staff: a few short sentences, plain text, no headings. Say which department got which task.`;
}

function officeStatus(): string {
  const lines = [`Company: ${getSettings().companyName}`];
  if (!state.departments.length) {
    lines.push("Departments: none yet.");
  } else {
    lines.push("Departments:");
    for (const d of state.departments) {
      const tasks = state.tasks.filter((t) => t.departmentId === d.id);
      const working = tasks.filter((t) => t.status === "working").length;
      const queued = tasks.filter((t) => t.status === "queued").length;
      lines.push(
        `- ${d.name} [id: ${d.id}]: ${d.genre}. Headcount ${d.headcount}, web access ${d.webAccess ? "yes" : "no"}. Working ${working}, queued ${queued}.`,
      );
      if (d.description) lines.push(`  Standing instructions: ${shorten(d.description, 240)}`);
    }
  }
  const recent = state.tasks.slice(-15);
  if (recent.length) {
    lines.push("Recent tasks (oldest first):");
    for (const t of recent) {
      const department = state.departments.find((d) => d.id === t.departmentId)?.name ?? "closed department";
      const detail = t.summary ? ` → ${shorten(t.summary, 160)}` : t.error ? ` → ${shorten(t.error, 120)}` : "";
      lines.push(`- ${t.id} | ${department} | ${t.status} | "${t.title}"${detail}`);
    }
  }
  return lines.join("\n");
}

function requireDepartment(ref: string): Department {
  const department = findDepartment(ref);
  if (!department) {
    const names = state.departments.map((d) => d.name).join(", ") || "none";
    throw new OfficeError(`No department "${ref}". Existing departments: ${names}.`);
  }
  return department;
}

function describeTool(name: string, input: unknown): string | null {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "create_department":
      return `Setting up the ${args.name ?? "new"} department`;
    case "update_department":
      return `Reorganising ${args.department ?? "a department"}`;
    case "close_department":
      return `Closing ${args.department ?? "a department"}`;
    case "assign_task":
      return `Handing "${args.title ?? "a task"}" to ${args.department ?? "a department"}`;
    case "cancel_task":
      return "Cancelling a task";
    case "get_task_result":
    case "read_file":
    case "list_files":
      return "Reviewing the work";
    case "memory":
      return "Checking notes";
    default:
      return null;
  }
}

function managerTools() {
  return [
    betaZodTool({
      name: "create_department",
      description: "Open a new department that specialises in one genre of work.",
      inputSchema: z.object({
        name: z.string().describe('Short team name, e.g. "Marketing"'),
        genre: z.string().describe('The kind of work it takes on, e.g. "copywriting, social posts and campaigns"'),
        instructions: z.string().describe("Standing instructions every worker in this department follows"),
        headcount: z.number().int().min(1).max(MAX_HEADCOUNT).optional().describe("Desks = tasks at once. Default 2."),
        web_access: z.boolean().optional().describe("Whether its workers may search and read the web. Default false."),
      }),
      run: (args) => {
        const d = createDepartment({
          name: args.name,
          genre: args.genre,
          description: args.instructions,
          headcount: args.headcount,
          webAccess: args.web_access,
        });
        return `Created ${d.name} [id: ${d.id}] with ${d.headcount} desk(s).`;
      },
    }),
    betaZodTool({
      name: "update_department",
      description: "Change a department's name, genre, standing instructions, headcount or web access.",
      inputSchema: z.object({
        department: z.string().describe("Department id or name"),
        name: z.string().optional(),
        genre: z.string().optional(),
        instructions: z.string().optional(),
        headcount: z.number().int().min(1).max(MAX_HEADCOUNT).optional(),
        web_access: z.boolean().optional(),
      }),
      run: (args) => {
        const d = requireDepartment(args.department);
        updateDepartment(d, {
          name: args.name,
          genre: args.genre,
          description: args.instructions,
          headcount: args.headcount,
          webAccess: args.web_access,
        });
        return `Updated ${d.name}.`;
      },
    }),
    betaZodTool({
      name: "close_department",
      description: "Close a department that has no open tasks. Its files stay on the drive.",
      inputSchema: z.object({ department: z.string().describe("Department id or name") }),
      run: ({ department }) => {
        const d = requireDepartment(department);
        closeDepartment(d);
        return `Closed ${d.name}.`;
      },
    }),
    betaZodTool({
      name: "assign_task",
      description: "Give a department a task. A worker starts as soon as a desk is free.",
      inputSchema: z.object({
        department: z.string().describe("Department id or name"),
        title: z.string().describe("Short task title, under 80 characters"),
        brief: z.string().describe("Self-contained brief: goal, audience, format, length, constraints"),
      }),
      run: ({ department, title, brief }) => {
        const d = requireDepartment(department);
        const task = assignTask(d, title, brief);
        return `Assigned ${task.id} to ${d.name} (${task.status === "working" ? "a worker started on it" : "queued"}).`;
      },
    }),
    betaZodTool({
      name: "cancel_task",
      description: "Cancel a queued or in-progress task.",
      inputSchema: z.object({ task_id: z.string() }),
      run: ({ task_id }) => {
        const task = findTask(task_id);
        if (!task) throw new OfficeError(`No task ${task_id}.`);
        cancelTask(task);
        return `Cancelling ${task_id}.`;
      },
    }),
    betaZodTool({
      name: "get_task_result",
      description: "Get a task's status, the worker's summary, its output files and any error.",
      inputSchema: z.object({ task_id: z.string() }),
      run: ({ task_id }) => {
        const t = findTask(task_id);
        if (!t) throw new OfficeError(`No task ${task_id}.`);
        return JSON.stringify({
          id: t.id,
          title: t.title,
          status: t.status,
          worker: t.workerName,
          summary: t.summary,
          outputs: t.outputs,
          error: t.error,
          recent_activity: t.activity.slice(-4),
        });
      },
    }),
    betaZodTool({
      name: "list_files",
      description: "List files on the company drive, optionally inside one department folder.",
      inputSchema: z.object({ folder: z.string().optional() }),
      run: ({ folder }) => listDrive(folder ?? "").join("\n") || "(no files yet)",
    }),
    betaZodTool({
      name: "read_file",
      description: "Read a file from the company drive.",
      inputSchema: z.object({ path: z.string().describe('Drive path, e.g. "marketing/launch-post.md"') }),
      run: ({ path }) => readDriveFile(path),
    }),
    createMemoryTool(COMPANY_MEMORY_DIR),
  ];
}

/** If the last turn stopped with tool calls that never got results, answer them before moving on. */
function danglingToolResults(): BetaToolResultBlockParam[] {
  const last = history.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return [];
  return last.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      type: "tool_result" as const,
      tool_use_id: (b as { id: string }).id,
      content: "Interrupted before this ran.",
      is_error: true,
    }));
}

export async function handleBossMessage(text: string) {
  if (managerStatus.busy) throw new OfficeError("The manager is still replying. Wait a moment.");
  addChat("boss", text);

  const client = getClient();
  if (!client) {
    addChat("system", "Add your Claude API key in Settings to bring the office to life.", { tone: "error" });
    return;
  }

  const { managerModel, companyName } = getSettings();
  const reply = addChat("manager", "", { streaming: true });
  managerStatus.busy = true;
  managerStatus.activity = "Reading your message";
  changed();

  const userMessage: BetaMessageParam = {
    role: "user",
    content: [
      ...danglingToolResults(),
      { type: "text", text: `<office_status>\n${officeStatus()}\n</office_status>\n\n${text}` },
    ],
  };

  try {
    const runner = client.beta.messages.toolRunner({
      ...modelParams(managerModel, "medium"),
      max_tokens: 32000,
      stream: true,
      max_iterations: MANAGER_MAX_ITERATIONS,
      cache_control: { type: "ephemeral" },
      system: systemPrompt(companyName),
      tools: managerTools(),
      messages: [...history, userMessage],
    });

    let last: BetaMessage | undefined;
    for await (const stream of runner) {
      let startedText = false;
      stream.on("text", (delta) => {
        if (!startedText && reply.text) reply.text += "\n\n";
        startedText = true;
        reply.text += delta;
        changed();
      });
      stream.on("contentBlock", (block) => {
        const line = blockActivity(block, describeTool);
        if (line) {
          managerStatus.activity = shorten(line, 90);
          changed();
        }
      });
      last = await stream.finalMessage();
      if (last.stop_reason === "refusal" || last.stop_reason === "max_tokens") break;
    }

    if (last?.stop_reason === "refusal") {
      // Leave the declined turn out of the history so the conversation can carry on.
      reply.text = "Sorry boss, I can't help with that one.";
    } else {
      history = runner.params.messages;
      reply.text = reply.text.trim() || finalText(last) || "Done.";
    }
  } catch (error) {
    reply.text = explainError(error);
    reply.tone = "error";
  } finally {
    reply.streaming = false;
    managerStatus.busy = false;
    managerStatus.activity = null;
    saveHistory();
    changed();
  }
}

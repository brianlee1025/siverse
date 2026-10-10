import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Department, Employee, Task } from "../shared/types";
import { shorten } from "./claude";
import {
  ClaudeCliError,
  protectedCodePaths,
  protectedCodeRules,
  protectedFileRules,
  resultError,
  rulePath,
  runClaudeCli,
  type ContentBlock,
} from "./claudeCli";
import { APPROVAL_TIMEOUT_MS, RUN_TIMEOUT_MS, commandSession, commandsBrief } from "./commands";
import { DATA_DIR, DRIVE_DIR, PORT, ROOT_DIR, departmentMemoryDir, employeeMemoryDir } from "./config";
import { employeeIntro } from "./employees";
import { taskBrief } from "./taskBrief";
import { getSettings } from "./settings";
import { changed } from "./store";

// A worker on the "claude-code" engine: one headless run of the Claude Code CLI per task, on the
// boss's own Claude plan. It works inside its department's folder on the company drive, which is
// the only place it can write besides its department's notes folder (and, for a permanent
// employee, their own notes folder); it can read the whole drive.
// The notes are the same plain files the API engine's memory tool uses, so a department keeps
// what it has learned when the office switches engines.

const ACTIVITY_LINES = 8;
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];
// Never needed for office work, and some can reach beyond the folders above. Approved commands
// don't need a shell either: Siverse runs them (server/commands.ts) through run_command.
const NEVER = ["Bash", "BashOutput", "KillShell", "Task", "NotebookEdit", "SlashCommand"];
const WORKER_MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "siverse-worker-mcp.mjs");
const RUNS_DIR = path.join(DATA_DIR, "runs");

function prompt(task: Task, department: Department, departmentDir: string, notesDir: string, employee?: Employee, myNotesDir?: string) {
  const { companyName } = getSettings();
  const commands = commandsBrief(department);
  const myNotes = employee
    ? `
- Your own notes are in ${myNotesDir}. Only you use them: what you know about your area, and a log of the tasks you have done. Read them before you start and build on your earlier work. Before you finish, add this task to your log (log.md: date, task, what you made and where) and update what you know about your area. Put what the whole department should know in the department's notes instead.`
    : "";
  return `You are ${task.workerName}, working in the ${department.name} department of ${companyName}, a company in Siverse, an office simulator where a real person is the boss and the work is real. The office manager hands you tasks from the boss.

Department focus: ${department.genre}
Standing instructions for this department:
${department.description || "(none yet)"}
${employee ? `\n${employeeIntro(employee, department)}\n` : ""}
Where things are:
- Your working folder is the current directory: ${departmentDir}
  Save every deliverable here, with paths relative to it. Use Markdown (.md) for documents and the right extension for code or data. If a task produces several files, put them in a folder named after the task.
- The company drive, with every department's work, is ${DRIVE_DIR}. You may read anything there, but only write in your own folder.${department.codeAccess ? codeAccessNote() : ""}
- Your department's notes are in ${notesDir}. Read every file there before you start: they hold the boss's preferences and lessons from earlier tasks. Before you finish, update them (for example notes.md): what the boss wants, decisions, recurring facts, mistakes to avoid. Keep them short and current, and remove anything that is no longer true. Never store secrets.${myNotes}

How to work:
- Do the task for real, with the tools you have.
- ${department.webAccess ? "You can search and read the web. Cite your sources in the deliverable." : "You have no internet access. Work from your own knowledge and the company drive, and flag facts that may be out of date."}
- Nobody can answer questions while you work. Make sensible assumptions and note them in the deliverable.
- When you're done, reply with a 2-4 sentence summary for the boss: what you made and where it is.
${commands ? `\n${commands}\n` : ""}
${taskBrief(task)}`;
}

function codeAccessNote() {
  return `
- You may also change Siverse's own code, the app this office runs in, at ${ROOT_DIR}. You can't change ${protectedCodePaths().join(", ")}: those hold the office's data and secrets and enforce the boss's approvals. Changes under src/ show in the browser right away. Changes under server/ restart the office, which ends your run on the spot: make server changes last, and update your change log before each one. Never commit or push.`;
}

function writeWorkerMcpConfig(task: Task): string {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${task.id}-mcp.json`);
  const config = {
    mcpServers: {
      siverse: {
        type: "stdio",
        command: process.execPath,
        args: [WORKER_MCP],
        env: { SIVERSE_URL: `http://127.0.0.1:${PORT}`, SIVERSE_TASK: task.id, SIVERSE_TOKEN: commandSession(task.id) },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

function describeTool(name: string, input: Record<string, unknown>, departmentDir: string): string | null {
  const file = typeof input.file_path === "string" ? relativeName(input.file_path, departmentDir) : null;
  switch (name) {
    case "Write":
      return `📝 Writing ${file ?? "a file"}`;
    case "Edit":
      return `✏️ Editing ${file ?? "a file"}`;
    case "Read":
      return `📖 Reading ${file ?? "a file"}`;
    case "Glob":
    case "Grep":
      return "🗂️ Looking through the drive";
    case "WebSearch":
      return `🔎 Searching the web${typeof input.query === "string" ? `: ${input.query}` : ""}`;
    case "WebFetch":
      return "🌐 Reading a web page";
    case "TodoWrite":
      return "🗒️ Planning the work";
    case "mcp__siverse__run_command":
      return `▶ Asking to run ${typeof input.name === "string" ? input.name : "a command"}`;
    default:
      return null;
  }
}

function relativeName(file: string, departmentDir: string) {
  const relative = path.relative(departmentDir, path.resolve(departmentDir, file));
  return relative.startsWith("..") ? path.basename(file) : relative.split(path.sep).join("/");
}

/** The drive path of a file the worker saved, if it is inside its department's folder. */
function drivePath(file: string, departmentDir: string): string | null {
  const absolute = path.resolve(departmentDir, file);
  const relative = path.relative(departmentDir, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return path.relative(DRIVE_DIR, absolute).split(path.sep).join("/");
}

function pushActivity(task: Task, line: string) {
  task.activity.push(shorten(line));
  if (task.activity.length > ACTIVITY_LINES) task.activity.splice(0, task.activity.length - ACTIVITY_LINES);
  changed();
}

/** Runs the task to completion on Claude Code and returns the worker's summary for the boss. */
export async function runClaudeCodeWorker(
  task: Task,
  department: Department,
  signal: AbortSignal,
  employee?: Employee,
): Promise<string> {
  const departmentDir = path.join(DRIVE_DIR, department.id);
  const notesDir = departmentMemoryDir(department.id);
  const myNotesDir = employee ? employeeMemoryDir(employee.id) : undefined;
  for (const dir of [departmentDir, notesDir, myNotesDir]) if (dir) fs.mkdirSync(dir, { recursive: true });

  // Writes only where this worker may write: never a bare Edit/Write, which reaches every file.
  const writable = [departmentDir, notesDir, myNotesDir, ...(department.codeAccess ? [ROOT_DIR] : [])];
  const allowed = [
    ...READ_ONLY_TOOLS,
    ...writable.flatMap((dir) => (dir ? [`Edit(${rulePath(dir)}/**)`] : [])),
    "TodoWrite",
    ...(department.webAccess ? WEB_TOOLS : []),
  ];
  const denied = [
    ...NEVER,
    ...(department.webAccess ? [] : WEB_TOOLS),
    ...protectedFileRules(),
    // data/ stays off-limits, except this worker's own notes, which the prompt asks it to update.
    ...(department.codeAccess ? protectedCodeRules([notesDir, ...(myNotesDir ? [myNotesDir] : [])]) : []),
  ];
  pushActivity(task, `👋 ${task.workerName} sat down to work`);

  // With approved commands, the worker gets run_command from scripts/siverse-worker-mcp.mjs.
  const mcpConfig = commandsBrief(department) ? writeWorkerMcpConfig(task) : null;
  if (mcpConfig) allowed.push("mcp__siverse");

  const result = await runClaudeCli({
    cwd: departmentDir,
    prompt: prompt(task, department, departmentDir, notesDir, employee, myNotesDir),
    args: [
      "--model", department.model ?? getSettings().workerModel,
      ...(department.effort ? ["--effort", department.effort] : []),
      "--allowedTools", ...allowed,
      "--disallowedTools", ...denied,
      "--add-dir", notesDir,
      ...(myNotesDir ? ["--add-dir", myNotesDir] : []),
      ...(department.codeAccess ? ["--add-dir", ROOT_DIR] : []),
      ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
      // Only the tools above: none of the MCP servers of the boss's own Claude Code setup.
      "--strict-mcp-config",
      // Office tasks are kept in Siverse; don't add them to the boss's Claude Code session list.
      "--no-session-persistence",
    ],
    // A run_command call can wait for the boss's OK and then for the command itself.
    env: { MCP_TOOL_TIMEOUT: String(APPROVAL_TIMEOUT_MS + RUN_TIMEOUT_MS + 5 * 60_000) },
    signal,
    onEvent: (event) => {
      if (event.type !== "assistant") return;
      for (const block of event.message?.content ?? ([] as ContentBlock[])) {
        if (block.type === "tool_use") {
          const line = describeTool(block.name, block.input ?? {}, departmentDir);
          if (line) pushActivity(task, line);
          if ((block.name === "Write" || block.name === "Edit") && typeof block.input?.file_path === "string") {
            const saved = drivePath(block.input.file_path, departmentDir);
            if (saved && !task.outputs.includes(saved)) {
              task.outputs.push(saved);
              changed();
            }
          }
        } else if (block.type === "text" && block.text.trim()) {
          pushActivity(task, `💬 ${block.text}`);
        }
      }
    },
  }).finally(() => {
    if (mcpConfig) fs.rmSync(mcpConfig, { force: true });
  });

  task.usage.inputTokens += result.usage?.input_tokens ?? 0;
  task.usage.outputTokens += result.usage?.output_tokens ?? 0;
  task.usage.cacheReadTokens += result.usage?.cache_read_input_tokens ?? 0;
  // Follow-ups add to the same task.
  if (typeof result.total_cost_usd === "number") task.costUsd = (task.costUsd ?? 0) + result.total_cost_usd;
  changed();

  if (result.is_error || result.subtype !== "success") throw new ClaudeCliError(resultError(result));
  pushActivity(task, "✅ Done");
  const summary = (result.result ?? "").trim();
  return summary || (task.outputs.length ? `Saved ${task.outputs.join(", ")}.` : "Finished.");
}

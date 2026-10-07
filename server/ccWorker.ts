import fs from "node:fs";
import path from "node:path";
import type { Department, Task } from "../shared/types";
import { shorten } from "./claude";
import { ClaudeCliError, resultError, runClaudeCli, type ContentBlock } from "./claudeCli";
import { DRIVE_DIR, departmentMemoryDir } from "./config";
import { getSettings } from "./settings";
import { changed } from "./store";

// A worker on the "claude-code" engine: one headless run of the Claude Code CLI per task, on the
// boss's own Claude plan. It works inside its department's folder on the company drive, which is
// the only place it can write besides its department's notes folder; it can read the whole drive.
// The notes are the same plain files the API engine's memory tool uses, so a department keeps
// what it has learned when the office switches engines.

const ACTIVITY_LINES = 8;
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const WRITE_TOOLS = ["Write", "Edit"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];
// Never needed for office work, and some can reach beyond the folders above.
const NEVER = ["Bash", "BashOutput", "KillShell", "Task", "NotebookEdit", "SlashCommand"];

function prompt(task: Task, department: Department, departmentDir: string, notesDir: string) {
  const { companyName } = getSettings();
  return `You are ${task.workerName}, working in the ${department.name} department of ${companyName}, a company in Siverse, an office simulator where a real person is the boss and the work is real. The office manager hands you tasks from the boss.

Department focus: ${department.genre}
Standing instructions for this department:
${department.description || "(none yet)"}

Where things are:
- Your working folder is the current directory: ${departmentDir}
  Save every deliverable here, with paths relative to it. Use Markdown (.md) for documents and the right extension for code or data. If a task produces several files, put them in a folder named after the task.
- The company drive, with every department's work, is ${DRIVE_DIR}. You may read anything there, but only write in your own folder.
- Your department's notes are in ${notesDir}. Read every file there before you start: they hold the boss's preferences and lessons from earlier tasks. Before you finish, update them (for example notes.md): what the boss wants, decisions, recurring facts, mistakes to avoid. Keep them short and current, and remove anything that is no longer true. Never store secrets.

How to work:
- Do the task for real, with the tools you have.
- ${department.webAccess ? "You can search and read the web. Cite your sources in the deliverable." : "You have no internet access. Work from your own knowledge and the company drive, and flag facts that may be out of date."}
- Nobody can answer questions while you work. Make sensible assumptions and note them in the deliverable.
- When you're done, reply with a 2-4 sentence summary for the boss: what you made and where it is.

Task ${task.id}: ${task.title}

Brief from the manager:
${task.brief}`;
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
export async function runClaudeCodeWorker(task: Task, department: Department, signal: AbortSignal): Promise<string> {
  const departmentDir = path.join(DRIVE_DIR, department.id);
  const notesDir = departmentMemoryDir(department.id);
  fs.mkdirSync(departmentDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });

  const allowed = [...READ_ONLY_TOOLS, ...WRITE_TOOLS, "TodoWrite", ...(department.webAccess ? WEB_TOOLS : [])];
  const denied = [...NEVER, ...(department.webAccess ? [] : WEB_TOOLS)];
  pushActivity(task, `👋 ${task.workerName} sat down to work`);

  const result = await runClaudeCli({
    cwd: departmentDir,
    prompt: prompt(task, department, departmentDir, notesDir),
    args: [
      "--model", getSettings().workerModel,
      "--allowedTools", ...allowed,
      "--disallowedTools", ...denied,
      "--add-dir", notesDir,
      // Only the tools above: none of the MCP servers of the boss's own Claude Code setup.
      "--strict-mcp-config",
      // Office tasks are kept in Siverse; don't add them to the boss's Claude Code session list.
      "--no-session-persistence",
    ],
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
  });

  task.usage.inputTokens += result.usage?.input_tokens ?? 0;
  task.usage.outputTokens += result.usage?.output_tokens ?? 0;
  task.usage.cacheReadTokens += result.usage?.cache_read_input_tokens ?? 0;
  if (typeof result.total_cost_usd === "number") task.costUsd = result.total_cost_usd;
  changed();

  if (result.is_error || result.subtype !== "success") throw new ClaudeCliError(resultError(result));
  pushActivity(task, "✅ Done");
  const summary = (result.result ?? "").trim();
  return summary || (task.outputs.length ? `Saved ${task.outputs.join(", ")}.` : "Finished.");
}

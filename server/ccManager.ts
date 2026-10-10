import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shorten } from "./claude";
import { ClaudeCliError, protectedFileRules, resultError, runClaudeCli, type ContentBlock, type StreamEvent } from "./claudeCli";
import { COMPANY_MEMORY_DIR, DATA_DIR, PORT } from "./config";
import { getSettings } from "./settings";
import { addChat, changed, managerStatus } from "./store";

// The manager on the "claude-code" engine: one Claude Code conversation, resumed for every boss
// message, with Siverse's office tools as an MCP server (scripts/siverse-mcp.mjs) that calls this
// server's local API. "New day" starts a fresh conversation; the notes in company memory stay.

const DESK_DIR = path.join(DATA_DIR, "manager-desk");
const SESSION_FILE = path.join(DATA_DIR, "manager-claude-code.json");
const MCP_CONFIG_FILE = path.join(DATA_DIR, "manager-mcp.json");
const MCP_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "siverse-mcp.mjs");

function readSessionId(): string | null {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")).sessionId ?? null;
  } catch {
    return null;
  }
}

function writeSessionId(sessionId: string | null) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (sessionId) fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId }));
  else fs.rmSync(SESSION_FILE, { force: true });
}

export function forgetClaudeCodeManager() {
  writeSessionId(null);
}

function writeMcpConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const config = {
    mcpServers: {
      siverse: {
        type: "stdio",
        command: process.execPath,
        args: [MCP_SERVER],
        env: { SIVERSE_URL: `http://127.0.0.1:${PORT}` },
      },
    },
  };
  fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2));
}

function describeTool(name: string): string | null {
  const tool = name.startsWith("mcp__siverse__") ? name.slice("mcp__siverse__".length) : name;
  switch (tool) {
    case "create_department":
      return "Setting up a department";
    case "update_department":
      return "Reorganising a department";
    case "close_department":
      return "Closing a department";
    case "assign_task":
      return "Handing out a task";
    case "cancel_task":
      return "Cancelling a task";
    case "hire_employee":
      return "Hiring";
    case "update_employee":
      return "Briefing an employee";
    case "fire_employee":
      return "Letting someone go";
    case "create_schedule":
    case "update_schedule":
    case "delete_schedule":
    case "run_schedule_now":
      return "Planning recurring work";
    case "follow_up_task":
      return "Following up on a task";
    case "office_status":
    case "get_task_result":
    case "read_file":
    case "list_files":
      return "Reviewing the work";
    case "Read":
    case "Write":
    case "Edit":
    case "Glob":
      return "Checking notes";
    default:
      return null;
  }
}

/** Answers one boss message with the manager on Claude Code. */
export async function handleBossMessageClaudeCode(text: string, officeStatus: string, instructions: string) {
  const reply = addChat("manager", "", { streaming: true });
  managerStatus.busy = true;
  managerStatus.activity = "Reading your message";
  changed();

  fs.mkdirSync(COMPANY_MEMORY_DIR, { recursive: true });
  writeMcpConfig();
  const notes = `Your notes about the boss and the company are files in ${COMPANY_MEMORY_DIR}. Read them at the start of a conversation, and update them when you learn a lasting preference or decision. Never store secrets.`;

  const run = (resume: string | null) =>
    runClaudeCli({
      cwd: DESK_DIR,
      prompt: `<office_status>\n${officeStatus}\n</office_status>\n\n${text}`,
      args: [
        "--model", getSettings().managerModel,
        "--append-system-prompt", `${instructions}\n\n${notes}\n\nYour office tools are the siverse MCP tools. Use them to act; don't just describe what you would do.`,
        "--mcp-config", MCP_CONFIG_FILE,
        "--strict-mcp-config",
        "--allowedTools", "mcp__siverse", "Read", "Glob", "Grep", "Write", "Edit",
        "--disallowedTools", "Bash", "BashOutput", "KillShell", "Task", "NotebookEdit", "WebSearch", "WebFetch", "SlashCommand",
        ...protectedFileRules(),
        "--add-dir", COMPANY_MEMORY_DIR,
        ...(resume ? ["--resume", resume] : []),
      ],
      signal: new AbortController().signal,
      onEvent: (event: StreamEvent) => {
        if (event.type !== "assistant") return;
        for (const block of event.message?.content ?? ([] as ContentBlock[])) {
          if (block.type === "text" && block.text.trim()) {
            reply.text += `${reply.text ? "\n\n" : ""}${block.text.trim()}`;
            changed();
          } else if (block.type === "tool_use") {
            const line = describeTool(block.name);
            if (line) {
              managerStatus.activity = shorten(line, 90);
              changed();
            }
          }
        }
      },
    });

  try {
    const previous = readSessionId();
    let result: StreamEvent;
    try {
      result = await run(previous);
    } catch (error) {
      // The saved conversation may be gone (cleared by Claude Code): start a new one.
      if (!previous) throw error;
      writeSessionId(null);
      reply.text = "";
      result = await run(null);
    }
    if (result.session_id) writeSessionId(result.session_id);
    if (result.is_error || result.subtype !== "success") throw new ClaudeCliError(resultError(result));
    // The final text is also in `result`; keep the streamed text when there was some.
    reply.text = reply.text.trim() || (result.result ?? "").trim() || "Done.";
  } catch (error) {
    reply.text = error instanceof Error ? error.message : String(error);
    reply.tone = "error";
  } finally {
    reply.streaming = false;
    managerStatus.busy = false;
    managerStatus.activity = null;
    changed();
  }
}

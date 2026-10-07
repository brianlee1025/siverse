import path from "node:path";
import type { Department, FeedItem, Task } from "../shared/types";
import { MAX_HEADCOUNT, isClaudeCode } from "../shared/types";
import { shorten } from "./claude";
import { DATA_DIR, DRIVE_DIR } from "./config";
import { changed, claudeCodeLive, newId, nextDepartmentColor, slugify, state } from "./store";

/** The office's own runs on the claude-code engine work in the drive or the data folder. */
function isOfficeRun(cwd: string) {
  const inside = (root: string) => {
    const relative = path.relative(root, path.resolve(cwd));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return inside(DRIVE_DIR) || inside(DATA_DIR);
}

// Turns Claude Code hook events into the office: each project folder becomes a department, each
// Claude Code session is a worker at a desk, and each subagent it launches walks in as another
// worker. Siverse only watches; it never calls Claude or touches your Claude Code login.

type HookEvent = Record<string, unknown>;

const STARTING_DESKS = 3;
const ACTIVITY_LINES = 8;
const FEED_LIMIT = 150;
const KEEP_FINISHED = 30;
const SESSION_IDLE_MS = 45 * 60_000; // a session with no events for this long has gone home
const PROJECT_IDLE_MS = 60 * 60_000; // an empty project zone is removed after this long

const sessionLastSeen = new Map<string, number>();
const sessionProject = new Map<string, string>(); // session id -> department id
const projectLastActive = new Map<string, number>();

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const firstString = (event: HookEvent, ...keys: string[]) => keys.map((k) => str(event[k])).find((v) => v?.trim());

function projectFor(cwd: string): Department {
  const existing = state.departments.find((d) => isClaudeCode(d) && d.projectPath === cwd);
  if (existing) return existing;
  const name = path.basename(cwd) || cwd;
  let id = `cc-${slugify(name)}`;
  for (let i = 2; state.departments.some((d) => d.id === id); i++) id = `cc-${slugify(name)}-${i}`;
  const department: Department = {
    id,
    name,
    genre: "Claude Code",
    description: "",
    color: nextDepartmentColor(),
    headcount: STARTING_DESKS,
    webAccess: false,
    createdAt: Date.now(),
    source: "claude-code",
    projectPath: cwd,
  };
  state.departments.push(department);
  return department;
}

function freeDesk(department: Department): number {
  const taken = new Set(
    state.tasks.filter((t) => t.departmentId === department.id && t.status === "working").map((t) => t.deskIndex),
  );
  let desk = 0;
  while (taken.has(desk) && desk < MAX_HEADCOUNT) desk++;
  if (desk >= MAX_HEADCOUNT) return taken.size % MAX_HEADCOUNT; // all desks busy: share one
  if (desk >= department.headcount) department.headcount = desk + 1;
  return desk;
}

function startWorker(department: Department, fields: Pick<Task, "id" | "title" | "workerName" | "kind" | "sessionId">): Task {
  const task: Task = {
    ...fields,
    departmentId: department.id,
    brief: "",
    status: "working",
    deskIndex: freeDesk(department),
    activity: [],
    outputs: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    createdAt: Date.now(),
    startedAt: Date.now(),
    source: "claude-code",
  };
  state.tasks.push(task);
  return task;
}

function finishWorker(task: Task, summary?: string) {
  if (task.status !== "working") return;
  task.status = "done";
  task.finishedAt = Date.now();
  if (summary) task.summary = shorten(summary, 600);
}

function pushActivity(task: Task, line: string) {
  if (task.activity.at(-1) === line) return;
  task.activity.push(shorten(line, 120));
  if (task.activity.length > ACTIVITY_LINES) task.activity.splice(0, task.activity.length - ACTIVITY_LINES);
}

function addFeed(role: FeedItem["role"], project: string, text: string) {
  claudeCodeLive.feed.push({ id: newId("feed"), role, project, text: shorten(text, 2000), at: Date.now() });
  if (claudeCodeLive.feed.length > FEED_LIMIT) claudeCodeLive.feed.splice(0, claudeCodeLive.feed.length - FEED_LIMIT);
}

function sessionTask(sessionId: string, cwd: string): Task {
  const id = `cc-session-${sessionId}`;
  const existing = state.tasks.find((t) => t.id === id && t.status === "working");
  if (existing) return existing;
  const departmentId = sessionProject.get(sessionId);
  const department = state.departments.find((d) => d.id === departmentId) ?? projectFor(cwd);
  sessionProject.set(sessionId, department.id);
  // A session that went home and came back (e.g. after a long break) gets a fresh worker.
  state.tasks = state.tasks.filter((t) => t.id !== id);
  return startWorker(department, {
    id,
    title: "Claude Code session",
    workerName: "Claude",
    kind: "session",
    sessionId,
  });
}

function subagentTask(session: Task, agentId: string, agentType: string): Task {
  const id = `cc-agent-${agentId}`;
  const existing = state.tasks.find((t) => t.id === id);
  if (existing) return existing;
  const department = state.departments.find((d) => d.id === session.departmentId)!;
  return startWorker(department, {
    id,
    title: agentType,
    workerName: agentType,
    kind: "subagent",
    sessionId: session.sessionId,
  });
}

function fileName(input: Record<string, unknown>) {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  return file ? path.basename(file) : "a file";
}

/** A short, human description of a Claude Code tool call. */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return `📖 Reading ${fileName(input)}`;
    case "Write":
      return `📝 Writing ${fileName(input)}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `✏️ Editing ${fileName(input)}`;
    case "Bash":
      return `⌨️ ${str(input.description) ?? str(input.command) ?? "Running a command"}`;
    case "Grep":
      return `🔎 Searching for "${str(input.pattern) ?? "…"}"`;
    case "Glob":
      return `🗂️ Looking for ${str(input.pattern) ?? "files"}`;
    case "WebFetch": {
      const url = str(input.url);
      let host = "a web page";
      try {
        if (url) host = new URL(url).hostname;
      } catch {
        // Keep the generic label.
      }
      return `🌐 Reading ${host}`;
    }
    case "WebSearch":
      return `🔎 Searching the web: ${str(input.query) ?? ""}`;
    case "Agent":
    case "Task":
      return `👥 Briefing ${str(input.subagent_type) ?? "a helper"}: ${str(input.description) ?? ""}`;
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return "🗒️ Updating the to-do list";
    default:
      if (toolName.startsWith("mcp__")) {
        const [, server, tool] = toolName.split("__");
        return `🔌 ${server}: ${tool ?? ""}`;
      }
      return `🛠️ ${toolName}`;
  }
}

export function handleHookEvent(event: HookEvent) {
  const name = str(event.hook_event_name);
  const sessionId = str(event.session_id);
  const cwd = str(event.cwd);
  if (!name || !sessionId || !cwd) return;
  // Workers and the manager on the claude-code engine are already in the office as themselves.
  if (isOfficeRun(cwd)) return;

  claudeCodeLive.lastEventAt = Date.now();
  sessionLastSeen.set(sessionId, Date.now());

  if (name === "SessionEnd") {
    for (const task of state.tasks) {
      if (isClaudeCode(task) && task.sessionId === sessionId) finishWorker(task);
    }
    sessionLastSeen.delete(sessionId);
    changed();
    return;
  }

  const session = sessionTask(sessionId, cwd);
  const project = state.departments.find((d) => d.id === session.departmentId)!;
  projectLastActive.set(project.id, Date.now());
  const agentId = str(event.agent_id);
  // Events from inside a subagent carry its id; everything else belongs to the main session.
  const actor = agentId ? subagentTask(session, agentId, str(event.agent_type) ?? "Helper") : session;

  switch (name) {
    case "SessionStart": {
      const title = firstString(event, "session_title");
      if (title) session.title = title;
      pushActivity(session, "👋 Starting a session");
      break;
    }
    case "UserPromptSubmit": {
      const prompt = firstString(event, "prompt", "prompt_text");
      if (prompt) {
        if (session.title === "Claude Code session") session.title = shorten(prompt, 80);
        session.brief = prompt;
        addFeed("you", project.name, prompt);
        pushActivity(session, `📥 ${prompt}`);
      }
      break;
    }
    case "PreToolUse": {
      const tool = str(event.tool_name);
      const input = (event.tool_input ?? {}) as Record<string, unknown>;
      if (tool) pushActivity(actor, describeToolCall(tool, input));
      break;
    }
    case "PostToolUseFailure": {
      const tool = str(event.tool_name);
      if (tool) pushActivity(actor, `⚠️ ${tool} didn't work out`);
      break;
    }
    case "SubagentStart": {
      if (!agentId) break;
      const prompt = firstString(event, "prompt", "prompt_text", "description");
      if (prompt) {
        actor.brief = prompt;
        actor.title = `${actor.workerName}: ${shorten(prompt, 70)}`;
      }
      pushActivity(actor, "👋 Picking up the brief");
      break;
    }
    case "SubagentStop": {
      if (agentId) finishWorker(actor, firstString(event, "last_assistant_message"));
      break;
    }
    case "Notification": {
      const type = str(event.notification_type);
      const message = firstString(event, "message");
      if (type === "permission_prompt") pushActivity(session, "✋ Needs your permission");
      else if (type === "idle_prompt") pushActivity(session, "💬 Waiting for you");
      else if (message) pushActivity(session, `🔔 ${message}`);
      break;
    }
    case "Stop": {
      const reply = firstString(event, "last_assistant_message");
      if (reply) {
        addFeed("claude", project.name, reply);
        session.summary = shorten(reply, 600);
      }
      pushActivity(session, "💬 Done. Waiting for you");
      break;
    }
  }
  changed();
}

/** Sends idle sessions home, removes empty project zones, and trims old finished workers. */
export function sweepClaudeCode() {
  const now = Date.now();
  let dirty = false;
  for (const [sessionId, seen] of sessionLastSeen) {
    if (now - seen < SESSION_IDLE_MS) continue;
    for (const task of state.tasks) {
      if (isClaudeCode(task) && task.sessionId === sessionId) finishWorker(task);
    }
    sessionLastSeen.delete(sessionId);
    dirty = true;
  }

  const busy = new Set(state.tasks.filter((t) => isClaudeCode(t) && t.status === "working").map((t) => t.departmentId));
  const before = state.departments.length;
  state.departments = state.departments.filter(
    (d) => !isClaudeCode(d) || busy.has(d.id) || now - (projectLastActive.get(d.id) ?? d.createdAt) < PROJECT_IDLE_MS,
  );
  if (state.departments.length !== before) dirty = true;

  const finished = state.tasks.filter((t) => isClaudeCode(t) && t.status !== "working");
  if (finished.length > KEEP_FINISHED) {
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((t) => t.id));
    state.tasks = state.tasks.filter((t) => !drop.has(t.id));
    dirty = true;
  }
  if (dirty) changed();
}

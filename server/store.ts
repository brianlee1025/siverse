import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovedCommand, ChatMessage, ChatRole, Department, Employee, FeedItem, Schedule, Snapshot, Task } from "../shared/types";
import { isClaudeCode } from "../shared/types";
import { isInstalled as claudeCodeHooksInstalled } from "./claudeCodeHooks";
import { DATA_DIR, MAX_CONCURRENT_WORKERS } from "./config";
import { commandViews } from "./commands";
import { planView } from "./planUsage";
import { settingsView } from "./settings";

interface PersistedState {
  departments: Department[];
  employees: Employee[];
  tasks: Task[];
  schedules: Schedule[];
  commands: ApprovedCommand[];
  chat: ChatMessage[];
}

const STATE_FILE = path.join(DATA_DIR, "state.json");
const SNAPSHOT_FINISHED_TASKS = 60;
const SNAPSHOT_CHAT = 200;

export const state: PersistedState = { departments: [], employees: [], tasks: [], schedules: [], commands: [], chat: [] };
export const managerStatus = { busy: false, activity: null as string | null };

// What your Claude Code sessions are doing. Kept in memory only: it mirrors live sessions,
// and Claude Code sends fresh events as soon as you use it again after a restart.
export const claudeCodeLive = { lastEventAt: null as number | null, feed: [] as FeedItem[] };

let hooksCheck = { at: 0, installed: false };
function hooksInstalled() {
  if (Date.now() - hooksCheck.at > 10_000) hooksCheck = { at: Date.now(), installed: claudeCodeHooksInstalled() };
  return hooksCheck.installed;
}
export function forgetHooksCheck() {
  hooksCheck.at = 0;
}

const PALETTE = ["#e07a5f", "#3d85c6", "#81b29a", "#f2cc8f", "#9b72cf", "#e5989b", "#48a9a6", "#d4a373"];

export function loadState() {
  try {
    Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch {
    return; // First run.
  }
  state.schedules ??= []; // Saved before schedules existed.
  state.employees ??= []; // Saved before permanent employees existed.
  state.commands ??= []; // Saved before approved commands existed.
  // Anything mid-flight when the server stopped can't be resumed.
  for (const task of state.tasks) {
    delete task.approval; // Nobody is waiting for an answer any more.
    if (task.status === "working") {
      task.status = "failed";
      task.error = "Interrupted because the server restarted. Ask the manager to reassign it.";
      task.finishedAt = Date.now();
    }
  }
  for (const msg of state.chat) msg.streaming = false;
}

let saveTimer: NodeJS.Timeout | undefined;
let notifyTimer: NodeJS.Timeout | undefined;
const listeners = new Set<() => void>();

export function onChange(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Call after any mutation: pushes a snapshot to browsers soon and saves to disk a bit later. */
export function changed() {
  notifyTimer ??= setTimeout(() => {
    notifyTimer = undefined;
    for (const listener of listeners) listener();
  }, 60);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

export function saveNow() {
  clearTimeout(saveTimer);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  const persisted: PersistedState = {
    ...state,
    departments: state.departments.filter((d) => !isClaudeCode(d)),
    tasks: state.tasks.filter((t) => !isClaudeCode(t)),
  };
  fs.writeFileSync(tmp, JSON.stringify(persisted));
  fs.renameSync(tmp, STATE_FILE);
}

export function snapshot(): Snapshot {
  const active = state.tasks.filter((t) => t.status === "queued" || t.status === "working");
  const finished = state.tasks
    .filter((t) => t.status !== "queued" && t.status !== "working")
    .slice(-SNAPSHOT_FINISHED_TASKS);
  return {
    settings: settingsView(),
    departments: state.departments,
    employees: state.employees,
    tasks: [...finished, ...active],
    schedules: state.schedules,
    commands: commandViews(),
    chat: state.chat.slice(-SNAPSHOT_CHAT),
    manager: { ...managerStatus },
    maxConcurrentWorkers: MAX_CONCURRENT_WORKERS,
    claudeCode: { hooksInstalled: hooksInstalled(), ...claudeCodeLive },
    plan: planView(),
  };
}

export function newId(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function addChat(role: ChatRole, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  const message: ChatMessage = { id: newId("msg"), role, text, at: Date.now(), ...extra };
  state.chat.push(message);
  changed();
  return message;
}

export function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "department"
  );
}

export function nextDepartmentColor() {
  const used = new Set(state.departments.map((d) => d.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[state.departments.length % PALETTE.length];
}

/** Finds an office department (not a Claude Code project) by id or case-insensitive name. */
export function findDepartment(ref: string): Department | undefined {
  const needle = ref.trim().toLowerCase();
  return state.departments.find(
    (d) => !isClaudeCode(d) && (d.id === needle || d.name.toLowerCase() === needle || d.id === slugify(ref)),
  );
}

/** Finds a permanent employee by id or case-insensitive name, optionally within one department. */
export function findEmployee(ref: string, departmentId?: string): Employee | undefined {
  const needle = ref.trim().toLowerCase();
  return state.employees.find(
    (e) => (!departmentId || e.departmentId === departmentId) && (e.id === needle || e.name.toLowerCase() === needle),
  );
}

export function findTask(id: string): Task | undefined {
  return state.tasks.find((t) => t.id === id);
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatRole, Department, Snapshot, Task } from "../shared/types";
import { DATA_DIR, MAX_CONCURRENT_WORKERS } from "./config";
import { settingsView } from "./settings";

interface PersistedState {
  departments: Department[];
  tasks: Task[];
  chat: ChatMessage[];
}

const STATE_FILE = path.join(DATA_DIR, "state.json");
const SNAPSHOT_FINISHED_TASKS = 60;
const SNAPSHOT_CHAT = 200;

export const state: PersistedState = { departments: [], tasks: [], chat: [] };
export const managerStatus = { busy: false, activity: null as string | null };

const PALETTE = ["#e07a5f", "#3d85c6", "#81b29a", "#f2cc8f", "#9b72cf", "#e5989b", "#48a9a6", "#d4a373"];

export function loadState() {
  try {
    Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch {
    return; // First run.
  }
  // Anything mid-flight when the server stopped can't be resumed.
  for (const task of state.tasks) {
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
  fs.writeFileSync(tmp, JSON.stringify(state));
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
    tasks: [...finished, ...active],
    chat: state.chat.slice(-SNAPSHOT_CHAT),
    manager: { ...managerStatus },
    maxConcurrentWorkers: MAX_CONCURRENT_WORKERS,
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

/** Finds a department by id or (case-insensitive) name. */
export function findDepartment(ref: string): Department | undefined {
  const needle = ref.trim().toLowerCase();
  return state.departments.find((d) => d.id === needle || d.name.toLowerCase() === needle || d.id === slugify(ref));
}

export function findTask(id: string): Task | undefined {
  return state.tasks.find((t) => t.id === id);
}

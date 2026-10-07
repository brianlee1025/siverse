import type { Department, Task } from "../shared/types";
import { MAX_HEADCOUNT, isClaudeCode } from "../shared/types";
import { DEMO_MODE, MAX_CONCURRENT_WORKERS } from "./config";
import { runClaudeCodeWorker } from "./ccWorker";
import { explainError } from "./claude";
import { runDemoWorker } from "./demo";
import { pickWorkerName } from "./names";
import { deleteDepartmentSchedules } from "./schedules";
import { aiOfficeEnabled, engineReady, getSettings } from "./settings";
import { addChat, changed, findDepartment, newId, nextDepartmentColor, slugify, state } from "./store";
import { runWorker } from "./worker";

// The office: departments, the task queue, and the scheduler that turns queued tasks into
// working workers while respecting each department's headcount.

const running = new Map<string, AbortController>();

export class OfficeError extends Error {}

const clampHeadcount = (n: number) => Math.min(MAX_HEADCOUNT, Math.max(1, Math.round(n)));

export function createDepartment(input: {
  name: string;
  genre: string;
  description: string;
  headcount?: number;
  webAccess?: boolean;
}): Department {
  const name = input.name.trim().slice(0, 40);
  if (!name) throw new OfficeError("A department needs a name.");
  if (findDepartment(name)) throw new OfficeError(`There is already a department called "${name}".`);
  let id = slugify(name);
  for (let i = 2; state.departments.some((d) => d.id === id); i++) id = `${slugify(name)}-${i}`;

  const department: Department = {
    id,
    name,
    genre: input.genre.trim().slice(0, 120),
    description: input.description.trim().slice(0, 2000),
    color: nextDepartmentColor(),
    headcount: clampHeadcount(input.headcount ?? 2),
    webAccess: input.webAccess ?? false,
    createdAt: Date.now(),
  };
  state.departments.push(department);
  changed();
  return department;
}

export function updateDepartment(
  department: Department,
  patch: Partial<Pick<Department, "name" | "genre" | "description" | "headcount" | "webAccess">>,
) {
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 40);
    const clash = findDepartment(name);
    if (!name) throw new OfficeError("A department needs a name.");
    if (clash && clash.id !== department.id) throw new OfficeError(`There is already a department called "${name}".`);
    department.name = name;
  }
  if (patch.genre !== undefined) department.genre = patch.genre.trim().slice(0, 120);
  if (patch.description !== undefined) department.description = patch.description.trim().slice(0, 2000);
  if (patch.headcount !== undefined) department.headcount = clampHeadcount(patch.headcount);
  if (patch.webAccess !== undefined) department.webAccess = patch.webAccess;
  changed();
  schedule();
}

export function closeDepartment(department: Department) {
  const active = state.tasks.filter(
    (t) => t.departmentId === department.id && (t.status === "queued" || t.status === "working"),
  );
  if (active.length) {
    throw new OfficeError(`${department.name} still has ${active.length} open task(s). Cancel them first.`);
  }
  state.departments = state.departments.filter((d) => d.id !== department.id);
  deleteDepartmentSchedules(department.id);
  changed();
}

export function assignTask(
  department: Department,
  title: string,
  brief: string,
  extra: Pick<Task, "scheduleId"> = {},
): Task {
  const task: Task = {
    id: newId("task"),
    departmentId: department.id,
    title: title.trim().slice(0, 120) || "Untitled task",
    brief: brief.trim(),
    status: "queued",
    activity: [],
    outputs: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    createdAt: Date.now(),
    ...extra,
  };
  state.tasks.push(task);
  changed();
  schedule();
  return task;
}

function rejectClaudeCode(task: Task) {
  if (isClaudeCode(task)) throw new OfficeError("That's a Claude Code session. Manage it from Claude Code.");
}

export function cancelTask(task: Task) {
  rejectClaudeCode(task);
  if (task.status === "queued") {
    finish(task, "cancelled", { error: "Cancelled by the boss." });
  } else if (task.status === "working") {
    running.get(task.id)?.abort();
  } else {
    throw new OfficeError(`Task ${task.id} is already ${task.status}.`);
  }
}

export function retryTask(task: Task): Task {
  rejectClaudeCode(task);
  const department = state.departments.find((d) => d.id === task.departmentId);
  if (!department) throw new OfficeError("That department no longer exists.");
  return assignTask(department, task.title, task.brief, { scheduleId: task.scheduleId });
}

function finish(task: Task, status: Task["status"], fields: Partial<Task> = {}) {
  Object.assign(task, fields, { status, finishedAt: Date.now() });
  changed();
}

/** Starts queued tasks, oldest first, while departments have free desks. */
export function schedule() {
  if (!aiOfficeEnabled() || !engineReady()) return;
  for (const task of state.tasks) {
    if (running.size >= MAX_CONCURRENT_WORKERS) return;
    if (task.status !== "queued") continue;

    const department = state.departments.find((d) => d.id === task.departmentId);
    if (!department) {
      finish(task, "failed", { error: "Its department was closed." });
      continue;
    }
    const working = state.tasks.filter((t) => t.departmentId === department.id && t.status === "working");
    if (working.length >= department.headcount) continue;

    const takenDesks = new Set(working.map((t) => t.deskIndex));
    let deskIndex = 0;
    while (takenDesks.has(deskIndex)) deskIndex++;
    start(task, department, deskIndex);
  }
}

function start(task: Task, department: Department, deskIndex: number) {
  const namesInUse = new Set(state.tasks.filter((t) => t.status === "working").map((t) => t.workerName ?? ""));
  const engine = getSettings().engine;
  Object.assign(task, {
    status: "working",
    startedAt: Date.now(),
    deskIndex,
    workerName: pickWorkerName(namesInUse),
    engine,
  });
  changed();

  const controller = new AbortController();
  running.set(task.id, controller);
  const run = DEMO_MODE ? runDemoWorker : engine === "claude-code" ? runClaudeCodeWorker : runWorker;
  run(task, department, controller.signal)
    .then((summary) => {
      finish(task, "done", { summary });
      addChat("system", `✅ ${task.workerName} in ${department.name} finished "${task.title}".`, {
        tone: "success",
      });
    })
    .catch((error) => {
      if (controller.signal.aborted) {
        finish(task, "cancelled", { error: "Cancelled by the boss." });
        return;
      }
      const message = explainError(error);
      finish(task, "failed", { error: message });
      addChat("system", `⚠️ "${task.title}" in ${department.name} failed: ${message}`, { tone: "error" });
    })
    .finally(() => {
      running.delete(task.id);
      schedule();
    });
}

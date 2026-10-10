import type { Department, Effort, Employee, Task } from "../shared/types";
import { MAX_HEADCOUNT, isClaudeCode } from "../shared/types";
import { DEMO_MODE, MAX_CONCURRENT_WORKERS } from "./config";
import { runClaudeCodeWorker } from "./ccWorker";
import { explainError } from "./claude";
import { runDemoWorker } from "./demo";
import { deleteDepartmentCommands, endCommandSession } from "./commands";
import { departmentStaff, fitStaffToDesks, removeDepartmentStaff } from "./employees";
import { pickWorkerName } from "./names";
import { deleteDepartmentSchedules } from "./schedules";
import { aiOfficeEnabled, engineReady, getSettings } from "./settings";
import { addChat, changed, findDepartment, newId, nextDepartmentColor, slugify, state } from "./store";
import { runWorker } from "./worker";

// The office: departments, the task queue, and the scheduler that turns queued tasks into
// working workers while respecting each department's headcount.

const running = new Map<string, AbortController>();
const finishListeners: ((task: Task) => void)[] = [];

/** Runs `fn` whenever a worker finishes a task, done or failed (schedules.ts starts chained tasks). */
export function onTaskFinished(fn: (task: Task) => void) {
  finishListeners.push(fn);
}

function notifyFinished(task: Task) {
  for (const fn of finishListeners) {
    try {
      fn(task);
    } catch (error) {
      console.error("[office]", error);
    }
  }
}

export class OfficeError extends Error {}

const clampHeadcount = (n: number) => Math.min(MAX_HEADCOUNT, Math.max(1, Math.round(n)));

export function createDepartment(input: {
  name: string;
  genre: string;
  description: string;
  headcount?: number;
  webAccess?: boolean;
  model?: string | null;
  effort?: Effort | null;
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
  setModelAndEffort(department, input);
  state.departments.push(department);
  changed();
  return department;
}

export function updateDepartment(
  department: Department,
  patch: Partial<Pick<Department, "name" | "genre" | "description" | "headcount" | "webAccess" | "codeAccess">> & {
    model?: string | null; // null = back to the office default
    effort?: Effort | null;
  },
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
  if (patch.headcount !== undefined) {
    const headcount = clampHeadcount(patch.headcount);
    fitStaffToDesks(department, headcount);
    department.headcount = headcount;
  }
  if (patch.webAccess !== undefined) department.webAccess = patch.webAccess;
  if (patch.codeAccess !== undefined) department.codeAccess = patch.codeAccess;
  setModelAndEffort(department, patch);
  changed();
  schedule();
}

/** Sets or clears (null or "") the department's own model and effort. Takes effect from the next task. */
function setModelAndEffort(department: Department, patch: { model?: string | null; effort?: Effort | null }) {
  if (patch.model !== undefined) {
    const model = patch.model?.trim();
    if (model) department.model = model;
    else delete department.model;
  }
  if (patch.effort !== undefined) {
    if (patch.effort) department.effort = patch.effort;
    else delete department.effort;
  }
}

export function closeDepartment(department: Department) {
  const active = state.tasks.filter(
    (t) => t.departmentId === department.id && (t.status === "queued" || t.status === "working"),
  );
  if (active.length) {
    throw new OfficeError(`${department.name} still has ${active.length} open task(s). Cancel them first.`);
  }
  state.departments = state.departments.filter((d) => d.id !== department.id);
  removeDepartmentStaff(department.id);
  deleteDepartmentSchedules(department.id);
  deleteDepartmentCommands(department.id);
  changed();
}

export function assignTask(
  department: Department,
  title: string,
  brief: string,
  extra: Pick<Task, "scheduleId" | "employeeId"> = {},
): Task {
  if (extra.employeeId && !departmentStaff(department.id).some((e) => e.id === extra.employeeId)) {
    throw new OfficeError(`That employee doesn't work in ${department.name}.`);
  }
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
  if (!task.employeeId) delete task.employeeId;
  if (!task.scheduleId) delete task.scheduleId;
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

// A retry is told what the attempt before it already did, so it carries on instead of starting over.
// Earlier notes are cut off first, so retrying a retry doesn't stack them.
const EARLIER_ATTEMPT = "\n\n(An earlier attempt at this task";

function briefForRetry(task: Task): string {
  const brief = task.brief.split(EARLIER_ATTEMPT)[0];
  if (!task.outputs.length && !task.activity.length) return brief;
  const why = (task.error ?? "it stopped").split("\n")[0].slice(0, 200);
  const files = task.outputs.slice(0, 20).join(", ").slice(0, 500) || "none";
  const steps = task.activity.slice(-5).join(" / ").slice(0, 400);
  return `${brief}${EARLIER_ATTEMPT} (${task.id}) stopped: ${why}. Files it already wrote: ${files}. Its last steps: ${steps}. Check those files and carry on from there; don't start over.)`;
}

export function retryTask(task: Task): Task {
  rejectClaudeCode(task);
  // A follow-up that failed: run that follow-up again on the same task.
  if (task.thread?.at(-1)?.role === "boss") return followUpTask(task);
  const department = state.departments.find((d) => d.id === task.departmentId);
  if (!department) throw new OfficeError("That department no longer exists.");
  // The same employee takes it again if they still work there.
  const employeeId = departmentStaff(department.id).some((e) => e.id === task.employeeId) ? task.employeeId : undefined;
  return assignTask(department, task.title, briefForRetry(task), { scheduleId: task.scheduleId, employeeId });
}

/**
 * Sends a finished task back to work with the boss's follow-up. It stays the same task: the same
 * employee picks it up (or a temp under the same name), with the conversation so far and the files
 * it already made. Without a message it re-runs a follow-up that failed.
 */
export function followUpTask(task: Task, text?: string): Task {
  rejectClaudeCode(task);
  if (task.status === "queued" || task.status === "working") {
    throw new OfficeError(`${task.workerName ?? "Someone"} is still on it. Follow up once it's done.`);
  }
  const department = state.departments.find((d) => d.id === task.departmentId);
  if (!department) throw new OfficeError("That department no longer exists.");
  const message = text?.trim().slice(0, 8000);
  const thread = task.thread ?? (task.summary ? [{ role: "worker" as const, text: task.summary, at: task.finishedAt ?? Date.now() }] : []);
  if (message) thread.push({ role: "boss", text: message, at: Date.now() });
  else if (thread.at(-1)?.role !== "boss") throw new OfficeError("What should they do next?");
  task.thread = thread;

  if (task.employeeId && !departmentStaff(department.id).some((e) => e.id === task.employeeId)) delete task.employeeId;
  task.status = "queued";
  task.activity = [];
  delete task.error;
  delete task.startedAt;
  delete task.finishedAt;
  // To the back of the queue, like any new piece of work.
  state.tasks.splice(state.tasks.indexOf(task), 1);
  state.tasks.push(task);
  changed();
  schedule();
  return task;
}

function finish(task: Task, status: Task["status"], fields: Partial<Task> = {}) {
  Object.assign(task, fields, { status, finishedAt: Date.now() });
  changed();
}

/**
 * Starts queued tasks, oldest first, while departments have free desks. A task for an employee
 * waits for them. Any other task goes to a temp at a desk without a permanent owner, or else to
 * an employee who is free and has nothing of their own waiting.
 */
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
    const busy = new Set(working.map((t) => t.employeeId));
    const staff = departmentStaff(department.id);
    const isFree = (e: Employee) => !busy.has(e.id) && !takenDesks.has(e.deskIndex);

    if (task.employeeId) {
      const employee = staff.find((e) => e.id === task.employeeId);
      if (employee) {
        if (isFree(employee)) start(task, department, employee.deskIndex, employee);
        continue;
      }
      delete task.employeeId; // They left: whoever is free takes it.
    }

    const owned = new Set(staff.map((e) => e.deskIndex));
    let tempDesk = 0;
    while (tempDesk < department.headcount && (takenDesks.has(tempDesk) || owned.has(tempDesk))) tempDesk++;
    if (tempDesk < department.headcount) {
      start(task, department, tempDesk);
      continue;
    }
    const waitingFor = new Set(state.tasks.filter((t) => t.status === "queued" && t.employeeId).map((t) => t.employeeId));
    const employee = staff.find((e) => isFree(e) && !waitingFor.has(e.id));
    if (employee) start(task, department, employee.deskIndex, employee);
  }
}

function start(task: Task, department: Department, deskIndex: number, employee?: Employee) {
  const namesInUse = new Set([
    ...state.tasks.filter((t) => t.status === "working").map((t) => t.workerName ?? ""),
    ...state.employees.map((e) => e.name),
  ]);
  const engine = getSettings().engine;
  Object.assign(task, {
    status: "working",
    startedAt: Date.now(),
    deskIndex,
    // A temp coming back for a follow-up keeps their name.
    workerName: employee?.name ?? (task.thread && !task.employeeId ? task.workerName : undefined) ?? pickWorkerName(namesInUse),
    engine,
  });
  if (employee) task.employeeId = employee.id;
  changed();

  const controller = new AbortController();
  running.set(task.id, controller);
  const run = DEMO_MODE ? runDemoWorker : engine === "claude-code" ? runClaudeCodeWorker : runWorker;
  run(task, department, controller.signal, employee)
    .then((summary) => {
      task.thread?.push({ role: "worker", text: summary, at: Date.now() });
      finish(task, "done", { summary });
      const what = task.thread ? "followed up on" : "finished";
      addChat("system", `✅ ${task.workerName} in ${department.name} ${what} "${task.title}".`, {
        tone: "success",
      });
      notifyFinished(task);
    })
    .catch((error) => {
      if (controller.signal.aborted) {
        finish(task, "cancelled", { error: "Cancelled by the boss." });
        return;
      }
      const message = explainError(error);
      finish(task, "failed", { error: message });
      addChat("system", `⚠️ "${task.title}" in ${department.name} failed: ${message}`, { tone: "error" });
      notifyFinished(task);
    })
    .finally(() => {
      running.delete(task.id);
      endCommandSession(task.id);
      schedule();
    });
}

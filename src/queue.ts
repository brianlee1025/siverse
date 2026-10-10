import type { Snapshot, Task } from "../shared/types";
import { isClaudeCode } from "../shared/types";

// Mirrors schedule() in server/office.ts:203-242. Keep it in step if the scheduler changes.
// The scheduler doesn't wait for plan limits (tasks start and fail), so there's no reason for that here.

/** Why each queued office task hasn't started yet, by task id. The first reason that applies wins. */
export function waitReasons(snapshot: Snapshot): Map<string, string> {
  const out = new Map<string, string>();
  const queued = snapshot.tasks.filter((t) => t.status === "queued" && !isClaudeCode(t));
  if (!queued.length) return out;
  const { settings, departments, employees, tasks } = snapshot;
  const working = tasks.filter((t) => t.status === "working" && !isClaudeCode(t));
  // Named employees with work of their own in the queue: their free desks are kept for them.
  const waitingFor = new Set(queued.map((t) => t.employeeId).filter(Boolean));

  for (const task of queued) {
    out.set(task.id, reason(task));
  }
  return out;

  function reason(task: Task): string {
    if (!settings.aiOffice) return "The AI office is off";
    if (!settings.ready) return "Setup needed: see Settings";
    const n = snapshot.maxConcurrentWorkers;
    if (working.length >= n) return `All ${n} office desks are busy`;
    const department = departments.find((d) => d.id === task.departmentId);
    if (!department) return "Starting…"; // the server fails it on the next pass
    const here = working.filter((t) => t.departmentId === department.id);
    if (here.length >= department.headcount) return `All ${department.headcount} desks in ${department.name} are busy`;

    const staff = employees.filter((e) => e.departmentId === department.id);
    const takenDesks = new Set(here.map((t) => t.deskIndex));
    const employee = task.employeeId ? staff.find((e) => e.id === task.employeeId) : undefined;
    if (employee) {
      const theirs = here.find((t) => t.employeeId === employee.id);
      if (theirs) return `Waiting for ${employee.name} (on “${theirs.title}”)`;
      if (takenDesks.has(employee.deskIndex)) return `Waiting for ${employee.name}'s desk`;
      return "Starting…";
    }
    const owned = new Set(staff.map((e) => e.deskIndex));
    for (let desk = 0; desk < department.headcount; desk++) {
      if (!takenDesks.has(desk) && !owned.has(desk)) return "Starting…"; // a temp desk is free
    }
    const busy = new Set(here.map((t) => t.employeeId));
    const freeStaff = staff.filter((e) => !busy.has(e.id) && !takenDesks.has(e.deskIndex));
    if (freeStaff.length && freeStaff.every((e) => waitingFor.has(e.id))) return "Desks are kept for staff with their own work";
    return "Starting…"; // schedule() runs on every change, so this only flashes
  }
}

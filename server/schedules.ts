import type { Department, Schedule, ScheduleCadence, Task } from "../shared/types";
import { describeCadence } from "../shared/types";
import { departmentStaff } from "./employees";
import { OfficeError, assignTask, onTaskFinished } from "./office";
import { aiOfficeEnabled } from "./settings";
import { addChat, changed, newId, state } from "./store";

// Recurring tasks: a department's standing job that comes round on a timetable, e.g. "every
// Monday at 09:00, find new padel clubs". Times are the server's local time. If the office was
// closed when one was due, it runs once as soon as the office opens, then keeps to its timetable.

const TICK_MS = 30_000;
const MAX_INTERVAL_HOURS = 24 * 28;
const MAX_SCHEDULES_PER_DEPARTMENT = 12;
const MAX_CHAIN = 5; // A after B after C…: longer chains are refused, and so is any loop
const HANDOVER_MAX_FILES = 20;
const HANDOVER_FILES_CHARS = 500;
const HANDOVER_SUMMARY_CHARS = 600;

export interface ScheduleInput {
  title: string;
  brief: string;
  cadence: ScheduleCadence;
  enabled?: boolean;
  employeeId?: string | null; // a permanent employee who always does it; null = whoever is free
}

function checkEmployee(departmentId: string, employeeId: string) {
  if (!departmentStaff(departmentId).some((e) => e.id === employeeId)) {
    throw new OfficeError("That employee doesn't work in this department.");
  }
}

/** Checks a cadence from the boss or the manager and returns a clean copy. */
export function cleanCadence(cadence: ScheduleCadence, selfId?: string): ScheduleCadence {
  switch (cadence.kind) {
    case "daily":
      return { kind: "daily", time: cleanTime(cadence.time) };
    case "weekly": {
      const day = Math.round(Number(cadence.day));
      if (!(day >= 0 && day <= 6)) throw new OfficeError("Pick a weekday from 0 (Sunday) to 6 (Saturday).");
      return { kind: "weekly", day, time: cleanTime(cadence.time) };
    }
    case "interval": {
      const hours = Math.round(Number(cadence.hours));
      if (!(hours >= 1 && hours <= MAX_INTERVAL_HOURS)) {
        throw new OfficeError(`Pick an interval from 1 to ${MAX_INTERVAL_HOURS} hours.`);
      }
      return { kind: "interval", hours };
    }
    case "after": {
      const leader = findSchedule(String(cadence.scheduleId ?? ""));
      if (!leader) throw new OfficeError("Pick the recurring task this one should run after.");
      // Walk the chain so A-after-B-after-A can't be saved.
      let link: Schedule | undefined = leader;
      for (let steps = 1; link; steps++) {
        if (link.id === selfId) {
          throw new OfficeError(
            steps === 1
              ? "A recurring task can't run after itself."
              : `That would make a loop: "${leader.title}" already runs after this one.`,
          );
        }
        if (steps > MAX_CHAIN) throw new OfficeError(`A chain can be at most ${MAX_CHAIN} tasks long.`);
        link = link.cadence.kind === "after" ? findSchedule(link.cadence.scheduleId) : undefined;
      }
      return { kind: "after", scheduleId: leader.id };
    }
    default:
      throw new OfficeError("A schedule runs daily, weekly, every few hours, or after another recurring task.");
  }
}

function cleanTime(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) throw new OfficeError(`"${time}" isn't a time. Use 24-hour HH:MM, e.g. 09:00.`);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The first run strictly after `after`, in local time. */
export function nextRun(cadence: ScheduleCadence, after: number): number {
  if (cadence.kind === "after") return Number.MAX_SAFE_INTEGER; // its leader starts it, never the clock
  if (cadence.kind === "interval") return after + cadence.hours * 3_600_000;
  const [hours, minutes] = cadence.time.split(":").map(Number);
  const at = new Date(after);
  at.setSeconds(0, 0);
  at.setHours(hours, minutes);
  if (cadence.kind === "daily") {
    if (at.getTime() <= after) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  let days = (cadence.day - at.getDay() + 7) % 7;
  if (days === 0 && at.getTime() <= after) days = 7;
  at.setDate(at.getDate() + days);
  return at.getTime();
}

export function createSchedule(department: Department, input: ScheduleInput): Schedule {
  if (state.schedules.filter((s) => s.departmentId === department.id).length >= MAX_SCHEDULES_PER_DEPARTMENT) {
    throw new OfficeError(`${department.name} already has ${MAX_SCHEDULES_PER_DEPARTMENT} schedules. Remove one first.`);
  }
  const cadence = cleanCadence(input.cadence);
  const now = Date.now();
  const schedule: Schedule = {
    id: newId("sched"),
    departmentId: department.id,
    title: input.title.trim().slice(0, 120) || "Recurring task",
    brief: input.brief.trim().slice(0, 8000),
    cadence,
    enabled: input.enabled ?? true,
    createdAt: now,
    nextRunAt: nextRun(cadence, now),
  };
  if (input.employeeId) {
    checkEmployee(department.id, input.employeeId);
    schedule.employeeId = input.employeeId;
  }
  if (!schedule.brief) throw new OfficeError("A schedule needs a brief: what should the worker do each time?");
  state.schedules.push(schedule);
  changed();
  return schedule;
}

export function updateSchedule(schedule: Schedule, patch: Partial<ScheduleInput>) {
  if (patch.title !== undefined) schedule.title = patch.title.trim().slice(0, 120) || schedule.title;
  if (patch.brief !== undefined) {
    const brief = patch.brief.trim().slice(0, 8000);
    if (!brief) throw new OfficeError("A schedule needs a brief.");
    schedule.brief = brief;
  }
  if (patch.cadence !== undefined) schedule.cadence = cleanCadence(patch.cadence, schedule.id);
  if (patch.enabled !== undefined) schedule.enabled = patch.enabled;
  if (patch.employeeId !== undefined) {
    if (patch.employeeId) checkEmployee(schedule.departmentId, patch.employeeId);
    if (patch.employeeId) schedule.employeeId = patch.employeeId;
    else delete schedule.employeeId;
  }
  // A new timetable, or coming back from a pause, counts from now: no catch-up for the pause.
  if (patch.cadence !== undefined || patch.enabled) schedule.nextRunAt = nextRun(schedule.cadence, Date.now());
  changed();
}

export function deleteSchedule(schedule: Schedule) {
  state.schedules = state.schedules.filter((s) => s.id !== schedule.id);
  changed();
}

export function deleteDepartmentSchedules(departmentId: string) {
  const before = state.schedules.length;
  state.schedules = state.schedules.filter((s) => s.departmentId !== departmentId);
  if (state.schedules.length !== before) changed();
}

export function findSchedule(id: string): Schedule | undefined {
  return state.schedules.find((s) => s.id === id);
}

/** Starts this schedule's task now, without moving its timetable. */
export function runScheduleNow(schedule: Schedule): Task {
  const department = state.departments.find((d) => d.id === schedule.departmentId);
  if (!department) throw new OfficeError("That schedule's department was closed.");
  return startRun(schedule, department);
}

/** "{date}" becomes the run's local date (YYYY-MM-DD), "{weekday}" its day. Local, not toISOString (UTC). */
function fillPlaceholders(text: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const weekday = at.toLocaleDateString("en-GB", { weekday: "long" });
  return text.split("{date}").join(date).split("{weekday}").join(weekday);
}

/** What the previous step of a chain left behind, so the next step can pick it up without guessing paths. */
function handOver(leader: Task): string {
  const title = (leader.scheduleId && findSchedule(leader.scheduleId)?.title) || leader.title;
  const files = leader.outputs.slice(0, HANDOVER_MAX_FILES).join(", ").slice(0, HANDOVER_FILES_CHARS) || "none";
  const summary = (leader.summary ?? "").slice(0, HANDOVER_SUMMARY_CHARS);
  return `

(This run follows "${title}" (${leader.id}), which just finished.
Its files: ${files}.
Its summary: ${summary})`;
}

function startRun(schedule: Schedule, department: Department, leader?: Task): Task {
  const brief = `${fillPlaceholders(schedule.brief, new Date())}

(This is a recurring task: ${describeCadence(schedule.cadence).toLowerCase()}. Earlier runs may have left work in your folder and lessons in your notes. Build on them: add what is new, keep what still holds, and don't repeat what was already done.)${leader ? handOver(leader) : ""}`;
  const employeeId = departmentStaff(department.id).some((e) => e.id === schedule.employeeId) ? schedule.employeeId : undefined;
  const task = assignTask(department, schedule.title, brief, { scheduleId: schedule.id, employeeId });
  schedule.lastRunAt = Date.now();
  schedule.lastTaskId = task.id;
  changed();
  return task;
}

function stillOpen(schedule: Schedule): boolean {
  return state.tasks.some(
    (t) => t.scheduleId === schedule.id && (t.status === "queued" || t.status === "working"),
  );
}

/** When a scheduled task finishes, starts the schedules set to run after it. */
function startFollowers(task: Task) {
  // A follow-up finishing is not a new run of the schedule.
  if (!task.scheduleId || task.thread || !aiOfficeEnabled()) return;
  const leader = findSchedule(task.scheduleId);
  if (!leader) return;
  for (const follower of [...state.schedules]) {
    if (!follower.enabled || follower.cadence.kind !== "after" || follower.cadence.scheduleId !== leader.id) continue;
    const department = state.departments.find((d) => d.id === follower.departmentId);
    if (!department) continue;
    if (task.status !== "done") {
      // An error, not info: the chat's quiet mode must keep it, or a broken chain goes unnoticed.
      addChat("system", `⏭️ Skipped "${follower.title}": "${leader.title}" didn't finish.`, { tone: "error" });
    } else if (stillOpen(follower)) {
      addChat("system", `⏭️ Skipped "${follower.title}" in ${department.name}: the last run is still going.`, { tone: "info" });
    } else {
      startRun(follower, department, task);
      addChat("system", `⛓️ ${department.name} started "${follower.title}" after "${leader.title}" finished.`, { tone: "info" });
    }
  }
}

/** Starts every schedule that has come due. A run still in progress skips the next one. */
export function tickSchedules(now = Date.now()) {
  if (!aiOfficeEnabled()) return;
  for (const schedule of [...state.schedules]) {
    if (!schedule.enabled || schedule.nextRunAt > now) continue;
    const department = state.departments.find((d) => d.id === schedule.departmentId);
    schedule.nextRunAt = nextRun(schedule.cadence, now);
    changed();
    if (!department) continue;
    if (stillOpen(schedule)) {
      addChat("system", `⏭️ Skipped "${schedule.title}" in ${department.name}: the last run is still going.`, { tone: "info" });
      continue;
    }
    startRun(schedule, department);
    addChat("system", `⏰ ${department.name} started its recurring task "${schedule.title}".`, { tone: "info" });
  }
}

export function startScheduleClock() {
  onTaskFinished(startFollowers);
  tickSchedules();
  setInterval(() => {
    try {
      tickSchedules();
    } catch (error) {
      console.error("[schedules]", error);
    }
  }, TICK_MS).unref();
}

/** "next run 13/10/2026, 09:00:00", or for a chained schedule, which one starts it. */
export function whenNext(s: Schedule): string {
  if (s.cadence.kind !== "after") return `next run ${new Date(s.nextRunAt).toLocaleString()}`;
  const leader = findSchedule(s.cadence.scheduleId);
  return leader ? `runs after "${leader.title}" (${leader.id}) finishes` : "waits on a removed schedule";
}

/** One line per schedule, for the manager's view of the office. */
export function describeSchedules(): string[] {
  return state.schedules.map((s) => {
    const department = state.departments.find((d) => d.id === s.departmentId)?.name ?? "closed department";
    const next = s.enabled ? whenNext(s) : "paused";
    const who = state.employees.find((e) => e.id === s.employeeId)?.name ?? "whoever is free";
    return `- ${s.id} | ${department} | ${who} | "${s.title}" | ${describeCadence(s.cadence)} | ${next}`;
  });
}

/** A weekly job that keeps a department's notes short and current. */
export function notesTidyUp(department: Department): ScheduleInput {
  return {
    title: `Tidy up ${department.name}'s notes`,
    brief: `Review every file in your department's notes. Merge duplicates, remove anything outdated or contradicted by later work, and keep the lessons and the boss's preferences that still hold. Keep the notes short and well organised, with the most important points first. Also look through your folder on the drive for decisions that should be recorded in the notes. Don't produce any other deliverable: reply with a short summary of what you changed.`,
    cadence: { kind: "weekly", day: 0, time: "20:00" },
  };
}

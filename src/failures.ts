import type { Employee, Schedule, Task } from "../shared/types";

// Why a task failed, read from its error text. The patterns mirror fixed strings in the server, so
// each one names where its text comes from. Keep them in step if those messages change.

// Must match the error the server gives tasks cut off by a restart (server/store.ts:57).
export const INTERRUPTED_PREFIX = "Interrupted because the server restarted";
// Notes the server appends to briefs. Must match server/schedules.ts:190, :182 and server/office.ts:172.
export const BRIEF_NOTES = [
  { start: "\n\n(This is a recurring task:", label: "⏰ recurring" },
  { start: "\n\n(This run follows ", label: "⛓️ hand-over" },
  { start: "\n\n(An earlier attempt at this task", label: "🔁 earlier attempt" },
] as const;

/** The manager's ask, then the server's notes in the order they appear, so the card can fold the notes. */
export function splitBrief(brief: string): { ask: string; notes: { label: string; text: string }[] } {
  const found = BRIEF_NOTES.map((note) => ({ ...note, at: brief.indexOf(note.start) }))
    .filter((note) => note.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (!found.length) return { ask: brief, notes: [] };
  const notes = found.map((note, i) => {
    const text = brief.slice(note.at, found[i + 1]?.at ?? brief.length).trim();
    const leader = note.label === "⛓️ hand-over" ? /^\(This run follows "([^"]*)"/.exec(text)?.[1] : undefined;
    return { label: leader ? `${note.label} (${leader})` : note.label, text };
  });
  return { ask: brief.slice(0, found[0].at), notes };
}

// The chain limit in server/schedules.ts:15 (MAX_CHAIN). The only copy in src/.
const MAX_CHAIN = 5;

export type FailureKind = "interrupted" | "plan-limit" | "setup" | "too-big" | "other";

export function failureKind(error?: string): FailureKind {
  if (!error) return "other";
  if (error.startsWith(INTERRUPTED_PREFIX)) return "interrupted";
  // server/claude.ts:77: the API's own rate limit, not the plan's; a retry in a moment is fine.
  if (/rate limited by the api/i.test(error)) return "other";
  // server/claudeCli.ts:330 wraps the CLI's text; raw texts like "You've hit your session limit · resets 12:50pm"
  // slip past that classifier and reach the task as they are.
  if (/usage limit|session limit|weekly limit|rate limit|limit reached|hit your .{0,20}limit/i.test(error)) return "plan-limit";
  // claudeCli.ts:224 (not installed), :331 (not signed in); worker.ts:138 (no key); claude.ts:74-75 (key rejected).
  if (/isn't signed in|isn't installed|can't find it|couldn't start claude code|api key/i.test(error)) return "setup";
  // claudeCli.ts:328 (turn limit); worker.ts:177 (ran out of room), :181 (step limit).
  if (/turn limit|step limit|ran out of room/i.test(error)) return "too-big";
  return "other";
}

/** "12:50pm" from "… resets 12:50pm", if the error says when the plan resets. */
export function resetHint(error?: string): string | undefined {
  return error?.match(/resets? (?:at )?([0-9:]+\s?[ap]m|\d{1,2}:\d{2})/i)?.[1];
}

export const FAILURE_CHIP: Record<Exclude<FailureKind, "other">, string> = {
  interrupted: "⏸️ interrupted", // U+FE0F: without it Windows may draw ⏸ from a text font as "II"
  "plan-limit": "⛽ plan limit",
  setup: "🔑 setup",
  "too-big": "✂️ too big",
};

/** Most useful first: a folded group of failures shows the chip of its highest-ranked member. */
export const KIND_RANK: FailureKind[] = ["plan-limit", "setup", "too-big", "interrupted", "other"];

/**
 * The chained schedules that didn't run because this task failed, in chain order. Empty once the task
 * was tried again: a successful retry keeps its scheduleId and restarts the chain (server/office.ts).
 */
export function skippedFollowers(task: Task, schedules: Schedule[], tasks: Task[]): Schedule[] {
  if (task.status !== "failed" || !task.scheduleId) return [];
  const finished = task.finishedAt ?? 0;
  if (tasks.some((t) => t.scheduleId === task.scheduleId && t.id !== task.id && t.createdAt > finished)) return [];
  const out: Schedule[] = [];
  let leader = task.scheduleId;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const next = schedules.filter((s) => s.enabled && s.cadence.kind === "after" && s.cadence.scheduleId === leader);
    if (!next.length) break;
    out.push(...next);
    leader = next[0].id;
  }
  return out;
}

/** A chain of "after" schedules from `root`, first follower at each step; `more` counts the others. */
export function chainFrom(root: Schedule, schedules: Schedule[]): { schedule: Schedule; more: number }[] {
  const steps = [{ schedule: root, more: 0 }];
  for (let i = 0; i < MAX_CHAIN; i++) {
    const last = steps[steps.length - 1].schedule;
    const next = schedules.filter((s) => s.cadence.kind === "after" && s.cadence.scheduleId === last.id);
    if (!next.length) break;
    steps.push({ schedule: next[0], more: next.length - 1 });
  }
  return steps;
}

/** The schedule a chain starts from: up the "after" links from `schedule`, at most MAX_CHAIN steps. */
export function chainRoot(schedule: Schedule, schedules: Schedule[]): Schedule {
  let root = schedule;
  for (let i = 0; i < MAX_CHAIN && root.cadence.kind === "after"; i++) {
    const leaderId = root.cadence.scheduleId;
    const leader = schedules.find((s) => s.id === leaderId);
    if (!leader) break;
    root = leader;
  }
  return root;
}

/** "Leo's Weekly report", or just the title when nobody in particular runs it. */
export function scheduleLabel(schedule: Schedule, employees: Employee[]): string {
  const name = schedule.employeeId && employees.find((e) => e.id === schedule.employeeId)?.name;
  return name ? `${name}'s ${schedule.title}` : schedule.title;
}

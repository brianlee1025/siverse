import type { Snapshot, Task, TaskStatus } from "../shared/types";
import { isClaudeCode } from "../shared/types";
import { APPROVAL_TIMEOUT_MINUTES, chainFrom, chainRoot, failureKind } from "./failures";
import { duration } from "./ui/Elapsed";

// Every snapshot is a fresh JSON.parse, so nothing is ever `===` the last one and React.memo can't
// skip anything. `share` hands back the previous objects wherever nothing changed.

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function shareList<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const byId = new Map(prev.map((item) => [item.id, item]));
  let unchanged = prev.length === next.length;
  const out = next.map((item, i) => {
    const old = byId.get(item.id);
    if (old && same(old, item)) {
      if (prev[i] !== old) unchanged = false;
      return old;
    }
    unchanged = false;
    return item;
  });
  return unchanged ? prev : out;
}

const shareValue = <T,>(prev: T, next: T): T => (same(prev, next) ? prev : next);

/** `next`, reusing `prev`'s objects where they are unchanged. Returns `prev` itself if nothing changed. */
export function share(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (!prev) return next;
  const out: Snapshot = {
    ...next,
    settings: shareValue(prev.settings, next.settings),
    departments: shareList(prev.departments, next.departments),
    employees: shareList(prev.employees, next.employees),
    tasks: shareList(prev.tasks, next.tasks),
    schedules: shareList(prev.schedules, next.schedules),
    commands: shareList(prev.commands, next.commands),
    chat: shareList(prev.chat, next.chat),
    manager: shareValue(prev.manager, next.manager),
    claudeCode: shareValue(prev.claudeCode, next.claudeCode),
    plan: shareValue(prev.plan, next.plan),
  };
  return (Object.keys(out) as (keyof Snapshot)[]).every((key) => out[key] === prev[key]) ? prev : out;
}

export interface TaskEvent {
  // "pipeline": the last step of a chain finished its round. "timeout": an approval went unanswered.
  kind: "done" | "failed" | "ask" | "back" | "pipeline" | "timeout";
  taskId: string; // "" = a plain toast that opens nothing
  text: string;
  // "back" only: what happened while the line was down.
  summary?: { finished: number; interrupted: number; failed: number; asking: number };
}

/**
 * Turns snapshot changes into "finished", "couldn't finish" and "needs your OK" events. The first
 * snapshot after a page load only seeds it, so a load doesn't replay old tasks. After a reconnect it
 * keeps what it saw, and the first snapshot sums up the gap as one "back" event instead of a burst.
 * Claude Code tasks are skipped: their subagents finish all the time.
 */
export function createTaskWatcher() {
  let seen: Map<string, Seen> | null = null;
  let summarise = false;
  return {
    reconnected() {
      summarise = true;
    },
    update(snapshot: Snapshot): TaskEvent[] {
      const events: TaskEvent[] = [];
      const next = new Map<string, Seen>();
      for (const task of snapshot.tasks) {
        if (isClaudeCode(task)) continue;
        const missed = task.commandRuns?.filter((r) => r.outcome === "no-answer") ?? [];
        const now = { status: task.status, asking: Boolean(task.approval), noAnswer: missed.length };
        next.set(task.id, now);
        if (!seen) continue;
        const before = seen.get(task.id);
        const department = snapshot.departments.find((d) => d.id === task.departmentId)?.name ?? "A department";
        if (now.asking && !before?.asking) {
          events.push({ kind: "ask", taskId: task.id, text: `✋ ${task.workerName ?? department} needs your OK` });
        }
        // Counted, not "stopped asking and the newest run is no-answer": the server clears `approval`
        // (commands.ts:296-297) before it records the run (:362-363), so the two can land in different snapshots.
        if (before && now.noAnswer > before.noAnswer) {
          events.push({
            kind: "timeout",
            taskId: task.id,
            text: `⌛ ${task.workerName ?? department} asked to run ${missed.at(-1)!.name}, but nobody answered in ${APPROVAL_TIMEOUT_MINUTES} min`,
          });
        }
        if (!before || before.status === now.status) continue;
        // Across a gap a task can go from waiting straight to done.
        if (now.status === "done" && (before.status === "working" || (summarise && before.status === "queued"))) {
          const round = roundFinished(task, snapshot);
          if (round) events.push({ kind: "pipeline", taskId: task.id, text: round });
          else events.push({ kind: "done", taskId: task.id, text: `✅ ${department} finished “${task.title}”` });
        } else if (now.status === "failed") {
          events.push({ kind: "failed", taskId: task.id, text: `⚠️ ${department} couldn't finish “${task.title}”` });
        }
      }
      const firstLoad = !seen;
      seen = next;
      if (!summarise || firstLoad) {
        summarise = false;
        return events;
      }
      summarise = false;
      // A missed approval keeps its own red toast: folded into "Office is back" nobody would notice it.
      const timeouts = events.filter((e) => e.kind === "timeout");
      return [backEvent(events.filter((e) => e.kind !== "timeout"), snapshot), ...timeouts];
    },
  };
}

type Seen = { status: TaskStatus; asking: boolean; noAnswer: number };

// A follower is started the moment its leader's task finishes (server/schedules.ts startFollowers).
const FOLLOW_SLACK_MS = 2 * 60_000;

/**
 * "🛠 Weekly report round finished: Priya → Leo → Sofia · 1 h 5 min" when `task` closes a whole
 * chain this round: it is the last enabled step, and each step started right after the one before
 * finished. A hand-started ▶ of a later step alone fails that check, so it gets the plain toast.
 */
function roundFinished(task: Task, snapshot: Snapshot): string | null {
  const { schedules, employees, tasks } = snapshot;
  const schedule = task.scheduleId ? schedules.find((s) => s.id === task.scheduleId) : undefined;
  if (!schedule || schedule.cadence.kind !== "after") return null;
  if (schedules.some((s) => s.enabled && s.cadence.kind === "after" && s.cadence.scheduleId === schedule.id)) return null;
  const root = chainRoot(schedule, schedules);
  const steps = chainFrom(root, schedules).map((step) => step.schedule);
  if (steps.length < 2 || steps.at(-1)!.id !== schedule.id || !root.lastRunAt) return null;
  if (task.createdAt < (schedule.lastRunAt ?? 0)) return null; // an older run finishing late
  for (let i = 1; i < steps.length; i++) {
    const started = steps[i].lastRunAt ?? 0;
    const led = tasks.some(
      (t) =>
        t.scheduleId === steps[i - 1].id &&
        t.status === "done" &&
        started - (t.finishedAt ?? 0) >= 0 &&
        started - (t.finishedAt ?? 0) <= FOLLOW_SLACK_MS,
    );
    if (started < root.lastRunAt || !led) return null;
  }
  const who = steps.map((s) => employees.find((e) => e.id === s.employeeId)?.name ?? s.title).join(" → ");
  return `🛠 ${root.title} round finished: ${who} · ${duration(Date.now() - root.lastRunAt)}`;
}

/** "🔌 Office is back · 2 finished · 1 interrupted", opening the first failed task, else the first finished one. */
function backEvent(events: TaskEvent[], snapshot: Snapshot): TaskEvent {
  const errorOf = (id: string) => snapshot.tasks.find((t) => t.id === id)?.error;
  const failedIds = events.filter((e) => e.kind === "failed").map((e) => e.taskId);
  const finished = events.filter((e) => e.kind === "done" || e.kind === "pipeline").length;
  const interrupted = failedIds.filter((id) => failureKind(errorOf(id)) === "interrupted").length;
  const failed = failedIds.length - interrupted;
  const asking = events.filter((e) => e.kind === "ask").length;
  const parts = [
    finished && `${finished} finished`,
    interrupted && `${interrupted} interrupted`,
    failed && `${failed} failed`,
    // Asks aren't listed: the sticky "needs your OK" toast says it (store.ts connect). `summary.asking` stays,
    // so a short blip with an ask still gets this toast.
  ].filter(Boolean);
  const taskId =
    failedIds[0] ?? events.find((e) => e.kind === "done" || e.kind === "pipeline")?.taskId ?? events[0]?.taskId ?? "";
  return {
    kind: "back",
    taskId,
    text: ["🔌 Office is back", ...parts].join(" · "),
    summary: { finished, interrupted, failed, asking },
  };
}

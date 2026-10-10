import { useState, type ReactNode } from "react";
import type { Department, Snapshot, Task } from "../../shared/types";
import { isClaudeCode } from "../../shared/types";
import {
  FAILURE_CHIP,
  failureKind,
  INTERRUPTED_PREFIX,
  KIND_RANK,
  resetHint,
  scheduleLabel,
  skippedFollowers,
} from "../failures";
import { waitReasons } from "../queue";
import { api, useStore } from "../store";
import { Elapsed } from "./Elapsed";

const NEEDS_YOU_WINDOW_MS = 24 * 60 * 60 * 1000; // failed tasks older than this stay in "Recent"

const STATUS_LABEL: Record<Task["status"], string> = {
  queued: "Waiting",
  working: "Working",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function TaskBoard({ snapshot }: { snapshot: Snapshot }) {
  const openModal = useStore((s) => s.openModal);
  const setBoardOpen = useStore((s) => s.setBoardOpen);
  const seenFailed = useStore((s) => s.seenFailed);
  const aiOffice = snapshot.settings.aiOffice;
  const departments = new Map(snapshot.departments.map((d) => [d.id, d]));
  const officeDepartments = snapshot.departments.filter((d) => !isClaudeCode(d));
  const officeTasks = snapshot.tasks.filter((t) => !isClaudeCode(t));
  const now = Date.now();
  const recentFail = (t: Task) => t.status === "failed" && now - (t.finishedAt ?? 0) < NEEDS_YOU_WINDOW_MS;
  // "Needs you": waiting for an OK, or failed lately and not opened yet. Shown there only, not twice.
  const needsYou = officeTasks.filter((t) => t.approval || (recentFail(t) && !seenFailed.includes(t.id)));
  const needsYouIds = new Set(needsYou.map((t) => t.id));
  // Cut off by a restart and not re-assigned since (a retry makes a new task with the same title).
  const interrupted = officeTasks.filter(
    (t) =>
      recentFail(t) &&
      !seenFailed.includes(t.id) && // "Not now", "Mark all seen" or opening it hides it here
      t.error?.startsWith(INTERRUPTED_PREFIX) &&
      !officeTasks.some(
        (o) => o.departmentId === t.departmentId && o.title === t.title && o.createdAt > (t.finishedAt ?? 0),
      ),
  );
  const working = officeTasks.filter((t) => t.status === "working" && !needsYouIds.has(t.id));
  const queued = officeTasks.filter((t) => t.status === "queued");
  const finished = officeTasks
    .filter((t) => t.status !== "working" && t.status !== "queued" && !needsYouIds.has(t.id))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 25);
  const claudeCodeLive = snapshot.tasks.filter((t) => isClaudeCode(t) && t.status === "working");

  // Repeated failures of the same task fold into the newest card ("failed 3×"). Approvals never fold.
  const newestFail = new Map<string, Task>();
  for (const t of needsYou) {
    if (t.approval || t.status !== "failed") continue;
    const key = `${t.departmentId}\u0000${t.title}`;
    const kept = newestFail.get(key);
    if (!kept || (t.finishedAt ?? 0) > (kept.finishedAt ?? 0)) newestFail.set(key, t);
  }
  const older = new Map<string, string[]>();
  // The folded card's chip comes from the member whose failure says most (a plan limit beats "interrupted").
  const chipFrom = new Map<string, Task>();
  const rank = (t: Task) => KIND_RANK.indexOf(failureKind(t.error));
  for (const t of needsYou) {
    if (t.approval || t.status !== "failed") continue;
    const kept = newestFail.get(`${t.departmentId}\u0000${t.title}`)!;
    if (kept.id !== t.id) older.set(kept.id, [...(older.get(kept.id) ?? []), t.id]);
    const best = chipFrom.get(kept.id) ?? kept; // on a tie the newest keeps it
    chipFrom.set(kept.id, rank(t) < rank(best) ? t : best);
  }
  const folded = new Set([...older.values()].flat());
  const needsYouShown = needsYou.filter((t) => !folded.has(t.id));
  const failedIds = needsYou.filter((t) => !t.approval && t.status === "failed").map((t) => t.id);
  const failedShown = needsYouShown.filter((t) => !t.approval && t.status === "failed").length;

  // "⏭️ Skipped: …" under a failed card whose chained schedules didn't run.
  const skipped = new Map<string, string>();
  for (const t of [...needsYouShown, ...finished]) {
    const chain = skippedFollowers(t, snapshot.schedules, snapshot.tasks);
    if (chain.length) skipped.set(t.id, chain.map((s) => scheduleLabel(s, snapshot.employees)).join(" → "));
  }

  return (
    <aside className="board" aria-label="Departments and tasks">
      <header className="panel-header">
        <strong>{aiOffice ? "Departments" : "Claude Code"}</strong>
        <div className="panel-header__actions">
          {aiOffice && (
            <button className="btn btn--ghost btn--sm" onClick={() => openModal({ type: "department", departmentId: null })}>
              ＋ New
            </button>
          )}
          <button className="icon-btn hide-lg" onClick={() => setBoardOpen(false)} aria-label="Close board">
            ✕
          </button>
        </div>
      </header>
      <div className="board__scroll">
        {!aiOffice ? (
          claudeCodeLive.length === 0 && (
            <p className="muted board__empty">
              Nothing running right now. Your Claude Code sessions and their subagents show up here while they work.
            </p>
          )
        ) : officeDepartments.length === 0 ? (
          <p className="muted board__empty">No departments yet. Ask the manager to open one, or add it yourself.</p>
        ) : (
          <ul className="dept-list">
            {officeDepartments.map((d) => {
              const busy = working.filter((t) => t.departmentId === d.id).length;
              const staff = snapshot.employees.filter((e) => e.departmentId === d.id).length;
              return (
                <li key={d.id}>
                  <button
                    className="dept-row"
                    onClick={() => openModal({ type: "department", departmentId: d.id })}
                    title={`${d.name}: ${d.genre}${staff ? ` · ${staff} on staff` : ""}`}
                  >
                    <span className="dot" style={{ background: d.color }} />
                    <span className="dept-row__name">
                      {d.name}
                      <small>{d.genre}</small>
                    </span>
                    <span className="dept-row__count">
                      {busy}/{d.headcount}
                      {staff ? <span className="muted"> · ★{staff}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <TaskSection
          title="✋ Needs you"
          tasks={needsYouShown}
          departments={departments}
          older={older}
          chipFrom={chipFrom}
          skipped={skipped}
          lead={interrupted.length > 0 && <ResumeInterrupted tasks={interrupted} />}
          action={
            failedShown >= 2 && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => useStore.getState().markFailedSeen(failedIds)}
                title="Move every failed task to Recent. Approvals stay."
              >
                Mark all seen
              </button>
            )
          }
        />
        <TaskSection title="⚡ Claude Code, live" tasks={claudeCodeLive} departments={departments} />
        <TaskSection title="Working" tasks={working} departments={departments} />
        <TaskSection title="Waiting for a desk" tasks={queued} departments={departments} notes={waitReasons(snapshot)} />
        <TaskSection title="Recent" tasks={finished} departments={departments} skipped={skipped} />
      </div>
    </aside>
  );
}

/** One row for everything a restart cut off. Never retries on its own: each retry spends plan usage. */
function ResumeInterrupted({ tasks }: { tasks: Task[] }) {
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    setBusy(true);
    let resumed = 0;
    try {
      for (const task of tasks) {
        await api("POST", `/api/tasks/${task.id}/retry`);
        resumed++;
      }
    } catch {
      // api() already showed the error; report what did go through.
    } finally {
      setBusy(false);
      const { markFailedSeen, showToast } = useStore.getState();
      markFailedSeen(tasks.slice(0, resumed).map((t) => t.id));
      if (resumed) showToast(`Resumed ${resumed} task${resumed === 1 ? "" : "s"}`);
    }
  };
  const n = tasks.length;
  return (
    <div className="resume-row">
      <span>
        🔁 The office restarted: {n} task{n === 1 ? " was" : "s were"} interrupted.
      </span>
      <button className="btn btn--primary btn--sm" onClick={resume} disabled={busy}>
        {busy ? "Resuming…" : "Resume all"}
      </button>
      <button
        className="btn btn--ghost btn--sm"
        onClick={() => useStore.getState().markFailedSeen(tasks.map((t) => t.id))}
        disabled={busy}
        title="Hide this. The tasks stay in Recent."
      >
        Not now
      </button>
    </div>
  );
}

function TaskSection({
  title,
  tasks,
  departments,
  lead,
  action,
  older,
  chipFrom,
  skipped,
  notes,
}: {
  title: string;
  tasks: Task[];
  departments: Map<string, Department>;
  lead?: ReactNode;
  action?: ReactNode; // a small button at the right of the heading
  older?: Map<string, string[]>; // folded earlier failures, by the id of the card that stands for them
  chipFrom?: Map<string, Task>; // the folded member whose chip the card shows
  skipped?: Map<string, string>; // "Draft report → Review", for failed tasks that broke a chain
  notes?: Map<string, string>; // why a queued task waits
}) {
  const selectTask = useStore((s) => s.selectTask);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  if (!tasks.length && !lead) return null;
  return (
    <section className="task-section">
      <h4 className="task-section__head">
        <span>
          {title} <span className="muted">{tasks.length}</span>
        </span>
        {action}
      </h4>
      {lead}
      {tasks.map((task) => {
        const department = departments.get(task.departmentId);
        const repeats = older?.get(task.id);
        const chipTask = chipFrom?.get(task.id) ?? task;
        const kind = task.status === "failed" ? failureKind(chipTask.error) : "other";
        const reset = kind === "plan-limit" ? resetHint(chipTask.error) : undefined;
        const latest = task.status === "failed" ? failureKind(task.error) : "other";
        const chain = skipped?.get(task.id);
        const note = notes?.get(task.id);
        return (
          <button
            key={task.id}
            className={`task-card${task.id === selectedTaskId ? " task-card--selected" : ""}`}
            onClick={() => {
              selectTask(task.id);
              if (repeats) useStore.getState().markFailedSeen(repeats); // the whole group leaves together
            }}
            style={{ borderLeftColor: department?.color ?? "#bbb" }}
          >
            <span className="task-card__top">
              <span className="task-card__title">{task.title}</span>
              {task.approval ? (
                <span className="pill pill--ask">Needs your OK</span>
              ) : (
                <span className={`pill pill--${task.status}`}>
                  {isClaudeCode(task) && task.status === "working" ? "Live" : STATUS_LABEL[task.status]}
                </span>
              )}
            </span>
            <span className="task-card__meta">
              {department?.name ?? "Closed department"}
              {task.workerName ? ` · ${task.workerName}` : ""}
              <Elapsed task={task} before=" · " />
              {repeats ? ` · failed ${repeats.length + 1}×` : ""}
              {chipTask !== task && latest !== "other" ? ` · latest: ${FAILURE_CHIP[latest]}` : ""}
            </span>
            {task.status === "working" && task.activity.length > 0 && (
              <span className="task-card__activity">{task.activity.at(-1)}</span>
            )}
            {task.status === "failed" && task.error && (
              <span className="task-card__activity task-card__activity--error">
                {kind !== "other" && (
                  <span className={`chip chip--${kind}`}>
                    {FAILURE_CHIP[kind]}
                    {reset ? ` · resets ${reset}` : ""}
                  </span>
                )}
                {task.error.split("\n")[0]}
              </span>
            )}
            {chain && <span className="task-card__activity muted">⏭️ Skipped: {chain}</span>}
            {note && <span className="task-card__activity muted">⏳ {note}</span>}
          </button>
        );
      })}
    </section>
  );
}

export { STATUS_LABEL };

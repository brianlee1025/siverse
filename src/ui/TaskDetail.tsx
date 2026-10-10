import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import type { Snapshot, Task } from "../../shared/types";
import { describeCadence, isClaudeCode } from "../../shared/types";
import { inkFor } from "../colors";
import { useDraft } from "../drafts";
import { failureKind, resetHint, scheduleLabel, skippedFollowers } from "../failures";
import { api, useStore } from "../store";
import { DriveMarkdown } from "./DriveMarkdown";
import { Elapsed } from "./Elapsed";
import { STATUS_LABEL } from "./TaskBoard";

export function TaskDetail({ snapshot }: { snapshot: Snapshot }) {
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const selectTask = useStore((s) => s.selectTask);
  const openModal = useStore((s) => s.openModal);
  const task = snapshot.tasks.find((t) => t.id === selectedTaskId);

  // Esc closes the card. It listens in the capture phase so it runs before an open window's own Esc
  // handler, and steps aside then: Esc closes the window on top, not both.
  useEffect(() => {
    if (!selectedTaskId) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || useStore.getState().modal) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLTextAreaElement && focused.value) return; // don't lose a half-typed message
      selectTask(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedTaskId, selectTask]);

  // Opening a task moves keyboard focus into the card; closing it puts focus back where it was.
  const heading = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const hasTask = Boolean(task);
  useEffect(() => {
    if (!hasTask) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.value) return; // the boss is typing: leave them be
    // Switching tasks from inside the card (e.g. "Try again") keeps the original place to return to.
    if (active instanceof HTMLElement && !active.closest(".task-detail")) returnTo.current = active;
    heading.current?.focus({ preventScroll: true });
  }, [selectedTaskId, hasTask]);
  useEffect(() => {
    if (selectedTaskId) return;
    const target = returnTo.current;
    returnTo.current = null;
    // Only if focus fell to the page when the card closed, never away from something the boss clicked.
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost && target?.isConnected) target.focus({ preventScroll: true });
  }, [selectedTaskId]);

  if (!task) return null;
  const department = snapshot.departments.find((d) => d.id === task.departmentId);
  const fromClaudeCode = isClaudeCode(task);
  const active = !fromClaudeCode && (task.status === "working" || task.status === "queued");
  const schedule = task.scheduleId ? snapshot.schedules.find((s) => s.id === task.scheduleId) : undefined;
  const canFollowUp = !fromClaudeCode && !active && Boolean(department) && snapshot.settings.aiOffice;

  const cancel = () => api("POST", `/api/tasks/${task.id}/cancel`);
  const retry = async () => {
    const next = await api<{ id: string }>("POST", `/api/tasks/${task.id}/retry`);
    selectTask(next.id);
  };
  // A failure gets the fix that suits it: resume, wait for the plan, check Settings, or split the task.
  const kind = task.status === "failed" ? failureKind(task.error) : "other";
  const skipped = skippedFollowers(task, snapshot.schedules, snapshot.tasks);
  const retryFirst = kind === "other" || kind === "interrupted" || skipped.length > 0;

  return (
    <div className="task-detail" role="dialog" aria-label={`Task: ${task.title}`}>
      <header className="task-detail__header" style={{ borderTopColor: department?.color }}>
        <div>
          <small style={{ color: department && inkFor(department.color) }}>
            {department?.name ?? "Closed department"}
            {task.workerName ? ` · ${task.workerName}` : ""}
            <Elapsed task={task} before=" · " />
          </small>
          <h3 ref={heading} tabIndex={-1}>
            {task.title}
          </h3>
        </div>
        <span className={`pill pill--${task.status}`}>
          {fromClaudeCode && task.status === "working" ? "Live" : STATUS_LABEL[task.status]}
        </span>
        <button className="icon-btn" onClick={() => selectTask(null)} aria-label="Close task details">
          ✕
        </button>
      </header>

      <div className="task-detail__body">
        {fromClaudeCode && (
          <p className="muted tiny">
            ⚡ {task.kind === "subagent" ? "A subagent" : "A session"} in your Claude Code
            {department?.projectPath ? <> · <code>{department.projectPath}</code></> : null}
          </p>
        )}
        {task.scheduleId && (
          <p className="muted tiny">
            ⏰ Recurring task{schedule ? ` · ${describeCadence(schedule.cadence).toLowerCase()}` : " (schedule removed)"}
          </p>
        )}
        {/* With a conversation, the request shows at its end, where the latest reply is. */}
        {task.approval && !task.thread?.length && <Approval task={task} snapshot={snapshot} />}
        {task.thread?.length ? (
          <Conversation task={task} snapshot={snapshot} color={department?.color} />
        ) : (
          task.summary && (
            <section>
              <h4>{fromClaudeCode ? "Latest reply" : "Summary"}</h4>
              <div className="prose">
                {/* Workers write paths relative to their department's folder (server/drive.ts). */}
                <DriveMarkdown base={`${task.departmentId}/`}>{task.summary}</DriveMarkdown>
              </div>
            </section>
          )
        )}
        {skipped.length > 0 && (
          <p className="hint">
            ⏭️ Skipped: {skipped.map((s) => scheduleLabel(s, snapshot.employees)).join(" → ")}. Trying again continues the
            chain.
          </p>
        )}
        {task.error && <p className="error-box">{task.error}</p>}
        {task.outputs.length > 0 && (
          <section>
            <h4>Deliverables</h4>
            <ul className="file-list">
              {task.outputs.map((path) => (
                <li key={path}>
                  <button className="link" onClick={() => openModal({ type: "file", path })}>
                    📄 {path}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {task.commandRuns?.length ? (
          <section>
            <h4>Commands</h4>
            <ul className="file-list">
              {task.commandRuns.map((run, i) => (
                <li key={i} className="tiny">
                  <code>{[run.name, ...run.args].join(" ")}</code> · {RUN_OUTCOME[run.outcome]}
                  {run.outcome === "failed" ? ` (exit ${run.exitCode})` : ""}
                  {run.askedBoss && run.outcome !== "denied" && run.outcome !== "no-answer" ? " · you approved it" : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {task.activity.length > 0 && (
          <section>
            <h4>Activity</h4>
            <ol className="activity">
              {task.activity.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          </section>
        )}
        {task.brief && (
          <details>
            <summary>{fromClaudeCode ? (task.kind === "subagent" ? "Its brief" : "Your latest request") : "Brief from the manager"}</summary>
            <p className="brief">{task.brief}</p>
          </details>
        )}
        {!fromClaudeCode && (
          <p className="muted tiny">
            {task.id} · {task.usage.inputTokens.toLocaleString()} in / {task.usage.outputTokens.toLocaleString()} out
            tokens
            {task.usage.cacheReadTokens ? ` · ${task.usage.cacheReadTokens.toLocaleString()} cached` : ""}
            {task.engine === "claude-code" &&
              ` · ran on Claude Code (your plan)${
                typeof task.costUsd === "number" ? `, about $${task.costUsd.toFixed(2)} if it had used the API` : ""
              }`}
          </p>
        )}
      </div>

      {kind === "plan-limit" && (
        <p className="muted tiny task-detail__why">
          Your plan's limit was hit. A retry before {resetHint(task.error) ?? "the reset"} will fail too.
        </p>
      )}
      {kind === "too-big" && (
        <p className="muted tiny task-detail__why">Too big for one run. Use the follow-up box to ask for the first part.</p>
      )}

      {canFollowUp && <FollowUp key={task.id} task={task} />}

      <footer className="task-detail__footer">
        {active && (
          <button className="btn btn--danger btn--sm" onClick={cancel}>
            {task.status === "working" ? "Send worker home" : "Cancel task"}
          </button>
        )}
        {kind === "setup" && (
          <button className="btn btn--primary btn--sm" onClick={() => openModal({ type: "settings" })}>
            Open Settings
          </button>
        )}
        {(task.status === "failed" || task.status === "cancelled") && (
          <button className={`btn btn--sm ${retryFirst ? "btn--primary" : "btn--ghost"}`} onClick={retry}>
            {kind === "interrupted" ? "Resume" : "Try again"}
          </button>
        )}
      </footer>
    </div>
  );
}

// Must match APPROVAL_TIMEOUT_MS in server/commands.ts:26 (off-limits to the office's workers). Kept here,
// not in shared/types.ts, because the server's tsx watch restarts on any change to a file it imports.
const APPROVAL_TIMEOUT_MINUTES = 30;
const URGENT_MINUTES = 5;
const MAX_EARLIER_ANSWERS = 3;

/** "Answer within 23 min", on its own slow clock so the card doesn't re-render. */
function AnswerBy({ requestedAt }: { requestedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.ceil((requestedAt + APPROVAL_TIMEOUT_MINUTES * 60_000 - now) / 60_000);
  return (
    <small className={left <= URGENT_MINUTES ? "approval__urgent" : "muted"}>
      {left <= 0 ? "About to time out" : `Answer within ${left} min`}
    </small>
  );
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const RUN_OUTCOME = {
  ok: "✅ ran",
  failed: "⚠️ failed",
  denied: "✋ you said no",
  "no-answer": "⌛ no answer",
  error: "⚠️ couldn't run",
} as const;

/** A worker is waiting for the boss's OK to run an approved command. */
function Approval({ task, snapshot }: { task: Task; snapshot: Snapshot }) {
  const [sending, setSending] = useState(false);
  const approval = task.approval!;
  const command = snapshot.commands.find((c) => c.id === approval.commandId);
  // Earlier times the boss said no (or didn't answer) to this same command on this task.
  const earlier = (task.commandRuns ?? [])
    .filter((run) => run.name === command?.name && (run.outcome === "denied" || run.outcome === "no-answer"))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_EARLIER_ANSWERS);
  const answer = async (approve: boolean) => {
    setSending(true);
    try {
      await api("POST", `/api/tasks/${task.id}/approval`, { approve });
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="approval" role="alert">
      <strong>✋ {task.workerName ?? "A worker"} wants to run</strong>
      <code>{approval.commandLine}</code>
      <span>“{approval.reason}”</span>
      {command && (
        <small className="muted">
          In {command.script.split("/").slice(0, -1).join("/")}/
          {command.secrets.length ? ` · gets ${command.secrets.join(", ")}` : ""}
          {command.scriptChanged ? " · runs the version you approved, not the changed one on the drive" : ""}
        </small>
      )}
      {earlier.length > 0 && (
        <small className="muted">
          Asked before:{" "}
          {earlier
            .map((run) => `${run.outcome === "denied" ? "you said no" : "no answer"} at ${time(run.at)}`)
            .join(" · ")}
        </small>
      )}
      <AnswerBy requestedAt={approval.requestedAt} />
      <div className="form__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => answer(false)} disabled={sending}>
          Don't run it
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => answer(true)} disabled={sending}>
          Approve and run
        </button>
      </div>
    </div>
  );
}

/** The boss's follow-ups and the worker's replies, oldest first. */
function Conversation({ task, snapshot, color }: { task: Task; snapshot: Snapshot; color?: string }) {
  const end = useRef<HTMLDivElement>(null);
  const count = task.thread?.length ?? 0;
  const waiting = task.status === "queued" || task.status === "working";
  const asking = Boolean(task.approval);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must not return one.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [count, waiting, asking]);
  return (
    <section className="task-thread">
      <h4>Conversation</h4>
      {task.thread?.map((message, i) =>
        message.role === "boss" ? (
          <div key={i} className="msg msg--boss">
            <div className="msg__bubble">{message.text}</div>
          </div>
        ) : (
          <div key={i} className="msg msg--manager">
            <div className="msg__bubble">
              <span className="task-thread__who" style={{ color: color && inkFor(color) }}>
                {task.workerName ?? "Worker"}
              </span>
              <Markdown>{message.text}</Markdown>
            </div>
          </div>
        ),
      )}
      {task.approval ? (
        <Approval task={task} snapshot={snapshot} />
      ) : waiting && (
        <div className="msg msg--manager">
          <div className="msg__bubble msg__placeholder">
            {task.status === "queued" ? `Waiting for ${task.workerName ?? "a free desk"}…` : (task.activity.at(-1) ?? "Working on it…")}
          </div>
        </div>
      )}
      <div ref={end} />
    </section>
  );
}

/** Ask the same worker to carry on with this task. */
function FollowUp({ task }: { task: Task }) {
  const showToast = useStore((s) => s.showToast);
  const [draft, setDraft, clearDraft] = useDraft(`followup:${task.id}`);
  const [sending, setSending] = useState(false);
  const who = task.workerName ?? "them";

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api("POST", `/api/tasks/${task.id}/follow-up`, { text });
      clearDraft();
      showToast(`${who} will carry on with "${task.title}".`);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <form className="chat__composer task-detail__followup" onSubmit={send}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={`Follow up: ask ${who} to carry on or change something…`}
        rows={2}
        maxLength={8000}
        aria-label="Follow-up message"
      />
      <button className="btn btn--primary" type="submit" disabled={!draft.trim() || sending}>
        Send
      </button>
    </form>
  );
}

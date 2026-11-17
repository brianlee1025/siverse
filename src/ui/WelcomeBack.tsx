import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../shared/types";
import { isClaudeCode } from "../../shared/types";
import { useStore } from "../store";
import { when } from "./TaskDetail";

// "While you were away": after 30 min or more away, one card with what happened since. The last time the
// boss was here is kept in this browser: written when the tab hides or closes, and every minute while it's
// visible (that covers a crash or a laptop asleep with the tab open: at most a minute is lost).

const KEY = "siverse.lastSeenAt";
const AWAY_MS = 30 * 60_000;
const FINISHED_CAP = 60; // SNAPSHOT_FINISHED_TASKS in server/store.ts:22: the snapshot keeps only this many

function readSeen(): number | null {
  try {
    const at = Number(localStorage.getItem(KEY));
    return at > 0 ? at : null;
  } catch {
    return null;
  }
}
function writeSeen() {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Storage unavailable (private mode): no card, nothing lost.
  }
}

interface Line {
  key: string;
  text: string;
  taskId?: string; // the first matching task; lines without one (or a path) are plain text
  path?: string; // a drive file: the line opens the file window
}

const shortPath = (p: string) => (p.length > 40 ? "…" + p.slice(-39) : p);

/** Worked out once, when the card opens, from the raw snapshot (office tasks hide while the AI office is off). */
function linesSince(snapshot: Snapshot, since: number): Line[] {
  const office = snapshot.tasks.filter((t) => !isClaudeCode(t));
  const finished = office.filter((t) => t.finishedAt);
  // The snapshot drops older finished tasks: if even the oldest one kept is newer than `since`, there may be more.
  const capped =
    finished.length >= FINISHED_CAP && Math.min(...finished.map((t) => t.finishedAt!)) > since ? "at least " : "";
  const done = finished.filter((t) => t.status === "done" && t.finishedAt! > since);
  const failed = finished.filter((t) => t.status === "failed" && t.finishedAt! > since);
  const asking = office.filter((t) => t.approval);
  const timedOut = office.filter((t) => t.commandRuns?.some((r) => r.outcome === "no-answer" && r.at > since));
  // Mirrors the late-run line in server/schedules.ts:254 ("⏰ … started its recurring task "…" late: …").
  const late = snapshot.chat.filter((m) => m.role === "system" && m.at > since && m.text.startsWith("⏰") && m.text.includes(" late:"));
  const newest = <T extends { finishedAt?: number }>(list: T[]) =>
    [...list].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  const lines: Line[] = [];
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  if (asking.length) lines.push({ key: "ask", text: askText(asking.length), taskId: asking[0].id });
  if (failed.length) lines.push({ key: "failed", text: `⚠️ ${capped}${n(failed.length, "task")} couldn't finish`, taskId: newest(failed).id });
  if (timedOut.length) lines.push({ key: "timeout", text: `⌛ ${n(timedOut.length, "approval")} timed out`, taskId: timedOut[0].id });
  if (done.length) lines.push({ key: "done", text: `✅ ${capped}${n(done.length, "task")} done`, taskId: newest(done).id });
  // What the time away produced: the files written by tasks done since (newest task first; a path written
  // twice counts once). Done tasks only: a failed task's half-written files aren't "made".
  const files = [...new Set([...done].sort((a, b) => b.finishedAt! - a.finishedAt!).flatMap((t) => t.outputs ?? []))];
  if (files.length)
    lines.push({ key: "files", text: `📄 ${capped}${n(files.length, "new file")} · newest: ${shortPath(files[0])}`, path: files[0] });
  if (late.length) lines.push({ key: "late", text: `⏰ ${n(late.length, "recurring task")} started late` });
  return lines;
}

function askText(count: number) {
  return `✋ ${count} ${count === 1 ? "task" : "tasks"} need${count === 1 ? "s" : ""} your OK`;
}

/** The frozen lines, with the ✋ line rewritten from the live snapshot (dropped at 0). */
function liveLines(lines: Line[], askingNow: number, firstAsk: string | undefined): Line[] {
  return lines.flatMap((line) =>
    line.key !== "ask" ? [line] : askingNow === 0 ? [] : [{ ...line, text: askText(askingNow), taskId: firstAsk }],
  );
}

export function WelcomeBack() {
  const hasSnapshot = useStore((s) => s.snapshot !== null);
  const selectTask = useStore((s) => s.selectTask);
  const askingNow = useStore((s) => s.snapshot?.tasks.filter((t) => t.approval && !isClaudeCode(t)).length ?? 0);
  const firstAsk = useStore((s) => s.snapshot?.tasks.find((t) => t.approval && !isClaudeCode(t))?.id);
  const [card, setCard] = useState<{ since: number; lines: Line[] } | null>(null);
  const checked = useRef(false); // nothing is written before the first check, or the old value would be lost
  const open = useRef(false);
  open.current = card !== null;

  /** Read the stored time first, then write the new one; open the card if the boss was away long enough. */
  const check = () => {
    const since = readSeen();
    writeSeen();
    const snapshot = useStore.getState().snapshot;
    if (since === null || !snapshot || Date.now() - since < AWAY_MS) return;
    // The chat marks what came in since (ChatPanel), even when no task line made the card.
    useStore.setState({ awaySince: since });
    const lines = linesSince(snapshot, since);
    if (lines.length) setCard({ since, lines });
  };

  // (a) The first snapshot after a page load. Never on a reconnect: "🔌 Office is back" covers that.
  useEffect(() => {
    if (!hasSnapshot || checked.current) return;
    checked.current = true;
    check();
  }, [hasSnapshot]);

  // (b) Coming back to the tab. Plus the writes: hidden, closing, and every minute while visible.
  useEffect(() => {
    const onVisibility = () => {
      if (!checked.current) return;
      if (document.hidden) writeSeen();
      else check();
    };
    const onHide = () => checked.current && writeSeen();
    // (c) A laptop sleep with the tab visible: no visibilitychange fires, but timers stop, so a tick that
    // comes far too late means the machine slept. `lastTick` moves on every tick, hidden or not, so a long
    // hidden spell (handled by (b)) doesn't count twice; if both fire, the second check sees < 30 min.
    let lastTick = Date.now();
    let unsubscribe: (() => void) | null = null;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const stopWaiting = () => {
      unsubscribe?.();
      unsubscribe = null;
      clearTimeout(waitTimer);
    };
    // The store may still hold the snapshot from before the sleep: wait for a fresh one (or 10 s).
    const checkWhenFresh = () => {
      if (unsubscribe) return;
      const before = useStore.getState().snapshot;
      const run = () => {
        stopWaiting();
        check();
      };
      unsubscribe = useStore.subscribe((s) => {
        if (s.snapshot !== before) run();
      });
      waitTimer = setTimeout(run, 10_000);
    };
    const timer = setInterval(() => {
      const now = Date.now();
      const slept = now - lastTick > 5 * 60_000;
      lastTick = now;
      if (!checked.current || document.hidden) return;
      if (slept) checkWhenFresh();
      else writeSeen();
    }, 60_000);
    // Esc closes the card, but only when no window or task card is open (they take Esc first). Registered
    // once, on mount, so it runs before the task card's own capture listener (added later) clears its state.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !open.current) return;
      const { modal, selectedTaskId } = useStore.getState();
      if (!modal && !selectedTaskId) setCard(null);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearInterval(timer);
      stopWaiting();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  // The ✋ line stays live (answering from the toast removes it); the other lines are "since you left".
  const lines = card ? liveLines(card.lines, askingNow, firstAsk) : [];
  const empty = card !== null && lines.length === 0;
  useEffect(() => {
    if (empty) setCard(null);
  }, [empty]);

  if (!card || empty) return null;
  return (
    <section className="welcome" role="status" aria-label="While you were away">
      <header className="welcome__head">
        <strong>While you were away</strong>
        <small className="muted">since {when(card.since)}</small>
        <button className="icon-btn welcome__close" onClick={() => setCard(null)} aria-label="Dismiss">
          ✕
        </button>
      </header>
      <ul className="welcome__lines">
        {lines.map((line) => (
          <li key={line.key}>
            {line.path ? (
              <button
                className="welcome__line"
                title={line.path}
                onClick={() => {
                  useStore.getState().openModal({ type: "file", path: line.path! });
                  setCard(null);
                }}
              >
                {line.text}
              </button>
            ) : line.taskId ? (
              <button
                className="welcome__line"
                onClick={() => {
                  selectTask(line.taskId!);
                  setCard(null);
                }}
              >
                {line.text}
              </button>
            ) : (
              <span className="welcome__line welcome__line--plain">{line.text}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

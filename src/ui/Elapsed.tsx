import { useEffect, useState } from "react";
import type { Task } from "../../shared/types";

export const duration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

const MIN_RUNS = 2;
const LONG_FACTOR = 1.5; // past this many times the usual run, it says "longer than usual"

/**
 * The median run time of a recurring task's finished runs, if at least two are in the snapshot.
 * Follow-ups are left out: their times span more than one run.
 */
export function usualRun(tasks: Task[], scheduleId: string): number | undefined {
  const runs = tasks
    .filter((t) => t.scheduleId === scheduleId && t.status === "done" && t.startedAt && t.finishedAt && !t.thread)
    .map((t) => t.finishedAt! - t.startedAt!)
    .sort((a, b) => a - b);
  if (runs.length < MIN_RUNS) return undefined;
  const mid = Math.floor(runs.length / 2);
  return runs.length % 2 ? runs[mid] : (runs[mid - 1] + runs[mid]) / 2;
}

/**
 * "working · 4 min" while a task runs, "took 6 min" once it's done. It keeps its own slow clock,
 * so only this text re-renders, not the board or the 3D office. With `usual`, a live run adds
 * "usually ~25 min".
 */
export function Elapsed({ task, before = "", usual }: { task: Task; before?: string; usual?: number }) {
  const live = task.status === "working" && Boolean(task.startedAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [live]);
  if (!task.startedAt) return null;
  if (live) {
    const ran = now - task.startedAt;
    const text = `${before}working · ${duration(ran)}`;
    if (!usual) return <>{text}</>;
    if (ran > usual * LONG_FACTOR) return <span className="elapsed--long">{`${text} · longer than usual`}</span>;
    return <>{`${text} · usually ~${duration(usual)}`}</>;
  }
  if (!task.finishedAt) return null;
  const verb = task.status === "done" ? "took" : "stopped after";
  return <>{`${before}${verb} ${duration(task.finishedAt - task.startedAt)}`}</>;
}

import { useEffect, useState } from "react";
import type { Task } from "../../shared/types";

export const duration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/**
 * "working · 4 min" while a task runs, "took 6 min" once it's done. It keeps its own slow clock,
 * so only this text re-renders, not the board or the 3D office.
 */
export function Elapsed({ task, before = "" }: { task: Task; before?: string }) {
  const live = task.status === "working" && Boolean(task.startedAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [live]);
  if (!task.startedAt) return null;
  if (live) return <>{`${before}working · ${duration(now - task.startedAt)}`}</>;
  if (!task.finishedAt) return null;
  const verb = task.status === "done" ? "took" : "stopped after";
  return <>{`${before}${verb} ${duration(task.finishedAt - task.startedAt)}`}</>;
}

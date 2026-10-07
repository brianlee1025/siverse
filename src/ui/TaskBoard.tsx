import type { Department, Snapshot, Task } from "../../shared/types";
import { isClaudeCode } from "../../shared/types";
import { useStore } from "../store";

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
  const aiOffice = snapshot.settings.aiOffice;
  const departments = new Map(snapshot.departments.map((d) => [d.id, d]));
  const officeDepartments = snapshot.departments.filter((d) => !isClaudeCode(d));
  const officeTasks = snapshot.tasks.filter((t) => !isClaudeCode(t));
  const working = officeTasks.filter((t) => t.status === "working");
  const queued = officeTasks.filter((t) => t.status === "queued");
  const finished = officeTasks
    .filter((t) => t.status !== "working" && t.status !== "queued")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 25);
  const claudeCodeLive = snapshot.tasks.filter((t) => isClaudeCode(t) && t.status === "working");

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
              return (
                <li key={d.id}>
                  <button className="dept-row" onClick={() => openModal({ type: "department", departmentId: d.id })}>
                    <span className="dot" style={{ background: d.color }} />
                    <span className="dept-row__name">
                      {d.name}
                      <small>{d.genre}</small>
                    </span>
                    <span className="dept-row__count">
                      {busy}/{d.headcount}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <TaskSection title="⚡ Claude Code, live" tasks={claudeCodeLive} departments={departments} />
        <TaskSection title="Working" tasks={working} departments={departments} />
        <TaskSection title="Waiting for a desk" tasks={queued} departments={departments} />
        <TaskSection title="Recent" tasks={finished} departments={departments} />
      </div>
    </aside>
  );
}

function TaskSection({ title, tasks, departments }: { title: string; tasks: Task[]; departments: Map<string, Department> }) {
  const selectTask = useStore((s) => s.selectTask);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  if (!tasks.length) return null;
  return (
    <section className="task-section">
      <h4>
        {title} <span className="muted">{tasks.length}</span>
      </h4>
      {tasks.map((task) => {
        const department = departments.get(task.departmentId);
        return (
          <button
            key={task.id}
            className={`task-card${task.id === selectedTaskId ? " task-card--selected" : ""}`}
            onClick={() => selectTask(task.id)}
            style={{ borderLeftColor: department?.color ?? "#bbb" }}
          >
            <span className="task-card__top">
              <span className="task-card__title">{task.title}</span>
              <span className={`pill pill--${task.status}`}>
                {isClaudeCode(task) && task.status === "working" ? "Live" : STATUS_LABEL[task.status]}
              </span>
            </span>
            <span className="task-card__meta">
              {department?.name ?? "Closed department"}
              {task.workerName ? ` · ${task.workerName}` : ""}
            </span>
            {task.status === "working" && task.activity.length > 0 && (
              <span className="task-card__activity">{task.activity.at(-1)}</span>
            )}
          </button>
        );
      })}
    </section>
  );
}

export { STATUS_LABEL };

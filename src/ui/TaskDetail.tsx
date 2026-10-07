import Markdown from "react-markdown";
import type { Snapshot } from "../../shared/types";
import { api, useStore } from "../store";
import { STATUS_LABEL } from "./TaskBoard";

export function TaskDetail({ snapshot }: { snapshot: Snapshot }) {
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const selectTask = useStore((s) => s.selectTask);
  const openModal = useStore((s) => s.openModal);
  const task = snapshot.tasks.find((t) => t.id === selectedTaskId);
  if (!task) return null;
  const department = snapshot.departments.find((d) => d.id === task.departmentId);
  const active = task.status === "working" || task.status === "queued";

  const cancel = () => api("POST", `/api/tasks/${task.id}/cancel`);
  const retry = async () => {
    const next = await api<{ id: string }>("POST", `/api/tasks/${task.id}/retry`);
    selectTask(next.id);
  };

  return (
    <div className="task-detail" role="dialog" aria-label={`Task: ${task.title}`}>
      <header className="task-detail__header" style={{ borderTopColor: department?.color }}>
        <div>
          <small style={{ color: department?.color }}>
            {department?.name ?? "Closed department"}
            {task.workerName ? ` · ${task.workerName}` : ""}
          </small>
          <h3>{task.title}</h3>
        </div>
        <span className={`pill pill--${task.status}`}>{STATUS_LABEL[task.status]}</span>
        <button className="icon-btn" onClick={() => selectTask(null)} aria-label="Close task details">
          ✕
        </button>
      </header>

      <div className="task-detail__body">
        {task.summary && (
          <section>
            <h4>Summary</h4>
            <div className="prose">
              <Markdown>{task.summary}</Markdown>
            </div>
          </section>
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
        <details>
          <summary>Brief from the manager</summary>
          <p className="brief">{task.brief}</p>
        </details>
        <p className="muted tiny">
          {task.id} · {task.usage.inputTokens.toLocaleString()} in / {task.usage.outputTokens.toLocaleString()} out tokens
          {task.usage.cacheReadTokens ? ` · ${task.usage.cacheReadTokens.toLocaleString()} cached` : ""}
        </p>
      </div>

      <footer className="task-detail__footer">
        {active && (
          <button className="btn btn--danger btn--sm" onClick={cancel}>
            {task.status === "working" ? "Send worker home" : "Cancel task"}
          </button>
        )}
        {(task.status === "failed" || task.status === "cancelled") && (
          <button className="btn btn--primary btn--sm" onClick={retry}>
            Try again
          </button>
        )}
      </footer>
    </div>
  );
}

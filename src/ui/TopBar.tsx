import type { Snapshot } from "../../shared/types";
import { useStore } from "../store";

export function TopBar({ snapshot }: { snapshot: Snapshot }) {
  const openModal = useStore((s) => s.openModal);
  const connected = useStore((s) => s.connected);
  const { chatOpen, boardOpen, setChatOpen, setBoardOpen } = useStore();
  const working = snapshot.tasks.filter((t) => t.status === "working").length;
  const queued = snapshot.tasks.filter((t) => t.status === "queued").length;
  const done = snapshot.tasks.filter((t) => t.status === "done").length;

  return (
    <header className="topbar">
      <button className="icon-btn topbar__mobile" onClick={() => setBoardOpen(!boardOpen)} aria-label="Toggle task board">
        ☰
      </button>
      <div className="topbar__brand">
        <span className="topbar__logo">🏢</span>
        <div>
          <strong>{snapshot.settings.companyName}</strong>
          <small>Siverse office</small>
        </div>
      </div>
      <div className="topbar__stats">
        <Stat label="departments" value={snapshot.departments.length} />
        <Stat label="working" value={`${working}/${snapshot.maxConcurrentWorkers}`} />
        <Stat label="queued" value={queued} />
        <Stat label="done" value={done} />
      </div>
      <div className="topbar__actions">
        {!connected && <span className="pill pill--warn">Reconnecting…</span>}
        <button className="btn btn--ghost" onClick={() => openModal({ type: "drive" })}>
          📁 <span className="hide-sm">Drive</span>
        </button>
        <button
          className={`btn btn--ghost${snapshot.settings.apiKeySource ? "" : " btn--attention"}`}
          onClick={() => openModal({ type: "settings" })}
        >
          ⚙️ <span className="hide-sm">Settings</span>
        </button>
        <button className="icon-btn topbar__mobile" onClick={() => setChatOpen(!chatOpen)} aria-label="Toggle chat">
          💬
        </button>
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

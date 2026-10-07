import type { Snapshot } from "../../shared/types";
import { isClaudeCode } from "../../shared/types";
import { useStore } from "../store";
import { claudeCodeIsLive } from "../claudeCode";

export function TopBar({ snapshot }: { snapshot: Snapshot }) {
  const openModal = useStore((s) => s.openModal);
  const connected = useStore((s) => s.connected);
  const chatOpen = useStore((s) => s.chatOpen);
  const boardOpen = useStore((s) => s.boardOpen);
  const setChatOpen = useStore((s) => s.setChatOpen);
  const setBoardOpen = useStore((s) => s.setBoardOpen);
  const setChatTab = useStore((s) => s.setChatTab);
  const officeTasks = snapshot.tasks.filter((t) => !isClaudeCode(t));
  const working = officeTasks.filter((t) => t.status === "working").length;
  const queued = officeTasks.filter((t) => t.status === "queued").length;
  const done = officeTasks.filter((t) => t.status === "done").length;
  const live = claudeCodeIsLive(snapshot);
  const { aiOffice } = snapshot.settings;
  const liveTasks = snapshot.tasks.filter((t) => isClaudeCode(t) && t.status === "working");
  const openClaudeCode = () => {
    setChatTab("claude-code");
    setChatOpen(true);
  };

  return (
    <header className="topbar">
      <button className="icon-btn topbar__mobile" onClick={() => setBoardOpen(!boardOpen)} aria-label="Toggle task board">
        ☰
      </button>
      <div className="topbar__brand">
        <span className="topbar__logo">🏢</span>
        <div>
          <strong>{snapshot.settings.companyName}</strong>
          <small>
            {aiOffice
              ? snapshot.settings.engine === "claude-code"
                ? "Siverse office · on your Claude plan"
                : "Siverse office"
              : "Watching Claude Code"}
          </small>
        </div>
      </div>
      <div className="topbar__stats">
        {aiOffice ? (
          <>
            <Stat label="departments" value={snapshot.departments.filter((d) => !isClaudeCode(d)).length} />
            <Stat label="working" value={`${working}/${snapshot.maxConcurrentWorkers}`} />
            <Stat label="queued" value={queued} />
            <Stat label="done" value={done} />
          </>
        ) : (
          <>
            <Stat label="projects" value={snapshot.departments.length} />
            <Stat label="sessions" value={liveTasks.filter((t) => t.kind === "session").length} />
            <Stat label="subagents" value={liveTasks.filter((t) => t.kind === "subagent").length} />
          </>
        )}
      </div>
      <div className="topbar__actions">
        {!connected && <span className="pill pill--warn">Reconnecting…</span>}
        <button
          className={`btn btn--ghost cc-pill${live ? " cc-pill--live" : ""}`}
          onClick={openClaudeCode}
          title={snapshot.claudeCode.hooksInstalled ? "Claude Code is connected" : "Connect Claude Code"}
        >
          <span className={`live-dot${live ? " live-dot--on" : ""}`} />
          <span className="hide-sm">Claude Code</span>
        </button>
        {aiOffice && (
          <button className="btn btn--ghost" onClick={() => openModal({ type: "drive" })}>
            📁 <span className="hide-sm">Drive</span>
          </button>
        )}
        <button
          className={`btn btn--ghost${aiOffice && !snapshot.settings.ready ? " btn--attention" : ""}`}
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

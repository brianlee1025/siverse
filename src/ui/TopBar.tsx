import type { PlanView, Snapshot, UsageWindow } from "../../shared/types";
import { isClaudeCode } from "../../shared/types";
import { api, useStore } from "../store";
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
        {!connected &&
          // A worker with code access was busy when the line dropped: most likely its own server edit.
          (officeTasks.some(
            (t) => t.status === "working" && snapshot.departments.find((d) => d.id === t.departmentId)?.codeAccess,
          ) ? (
            <span className="pill pill--warn" title="A code change is restarting the office. It reconnects by itself.">
              🔧 Office restarting…
            </span>
          ) : (
            <span className="pill pill--warn" title="Can't reach the office server. Retrying…">
              Reconnecting…
            </span>
          ))}
        <PlanMeter plan={snapshot.plan} />
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

const PLAN_NAMES: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "Free" };

/** Your Claude plan and what is left of its 5-hour and weekly limits. */
function PlanMeter({ plan }: { plan: PlanView }) {
  if (!plan.cli || plan.signedIn === null) return null;
  if (!plan.signedIn) {
    return (
      <span
        className="pill pill--warn"
        title="Siverse uses the Claude Code CLI on this computer, and it isn't signed in. Run it in a terminal and type /login."
      >
        Claude Code: not signed in
      </span>
    );
  }
  const name = plan.plan ? (PLAN_NAMES[plan.plan] ?? plan.plan) : "Claude";
  const updated = plan.updatedAt ? `Usage as of ${formatTime(plan.updatedAt)}.` : "No usage reported yet.";
  return (
    <div className={`plan${plan.limited ? " plan--limited" : ""}`} title={`Your Claude ${name} plan. ${updated}`}>
      <span className="plan__name">{name}</span>
      <Meter label="5h" window={plan.fiveHour} />
      <Meter label="Week" window={plan.sevenDay} className="hide-sm" />
      <button
        type="button"
        className="plan__check"
        onClick={() => api("POST", "/api/plan/check")}
        disabled={plan.checking}
        aria-label="Check usage now"
        title="Check now. This runs a tiny Claude Code request on Haiku, which uses a sliver of your plan. Usage also updates by itself whenever the office runs on Claude Code."
      >
        {plan.checking ? "…" : "↻"}
      </button>
    </div>
  );
}

function Meter({ label, window, className = "" }: { label: string; window: UsageWindow | null; className?: string }) {
  const left = window ? Math.max(0, 100 - window.usedPercent) : null;
  const tone = left === null ? "unknown" : left > 50 ? "ok" : left > 20 ? "low" : "out";
  const title = window
    ? `${label}: ${Math.round(window.usedPercent)}% used, ${Math.round(left ?? 0)}% left. Resets ${formatTime(window.resetsAt)}.`
    : `${label}: unknown until Siverse's next Claude Code run. Press ↻ to check now.`;
  return (
    <span className={`meter meter--${tone} ${className}`} title={title}>
      <span className="meter__label">{label}</span>
      <span className="meter__bar">
        <span className="meter__fill" style={{ width: `${left ?? 0}%` }} />
      </span>
      <span className="meter__value">{left === null ? "—" : `${Math.round(left)}%`}</span>
    </span>
  );
}

/** "15:00" today, otherwise "Tue 09:00". */
function formatTime(at: number) {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

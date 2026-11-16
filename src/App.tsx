import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "../shared/types";
import { isClaudeCode } from "../shared/types";
import { OfficeScene } from "./scene/OfficeScene";
import { LIGHT_PINS, useStore, type LightPin, type Toast as ToastItem } from "./store";
import { ChatPanel } from "./ui/ChatPanel";
import { minutesLeft, URGENT_MINUTES } from "./failures";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { Modals } from "./ui/Modals";
import { TaskBoard } from "./ui/TaskBoard";
import { TaskDetail } from "./ui/TaskDetail";
import { TopBar } from "./ui/TopBar";
import { WelcomeBack } from "./ui/WelcomeBack";
import { canWalk, WalkHud } from "./world/WalkHud";

export function App() {
  const raw = useStore((s) => s.snapshot);
  const snapshot = useMemo(() => raw && visibleSnapshot(raw), [raw]);
  const chatOpen = useStore((s) => s.chatOpen);
  const boardOpen = useStore((s) => s.boardOpen);
  const openModal = useStore((s) => s.openModal);
  const modal = useStore((s) => s.modal);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const selectTask = useStore((s) => s.selectTask);
  const [sceneKey, setSceneKey] = useState(0); // bumping it rebuilds the 3D office after a crash

  // First visit with the office unable to run (no API key, or no Claude Code CLI): open Settings
  // once (per browser) so the boss knows what to do.
  const checkedKey = useRef(false);
  useEffect(() => {
    if (!snapshot || checkedKey.current) return;
    checkedKey.current = true;
    if (!snapshot.settings.aiOffice || snapshot.settings.ready) return;
    try {
      if (localStorage.getItem("siverse.promptedForKey")) return;
      localStorage.setItem("siverse.promptedForKey", "1");
    } catch {
      // Storage unavailable (private mode): prompt anyway.
    }
    openModal({ type: "settings" });
  }, [snapshot, openModal]);

  // Links into the office: ?open=drive | department:<id> | file:<path>, and ?task=<id> or #task=<id>.
  // Also ?phase=morning|day|evening|night (lighting, this visit only), ?view=outside (start zoomed out),
  // ?view=walk (start in walk mode) and ?colliders (draw the walk-mode colliders).
  // Read once, on the first snapshot, then wiped from the address bar so a reload doesn't reopen them.
  const checkedLink = useRef(false);
  useEffect(() => {
    if (!snapshot || checkedLink.current) return;
    checkedLink.current = true;
    const params = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.slice(1));
    const open = params.get("open");
    const taskId = params.get("task") ?? hash.get("task");
    const phase = params.get("phase");
    const view = params.get("view");
    const colliders = params.has("colliders");
    if (!open && !taskId && !phase && !view && !colliders) return;
    if (colliders) useStore.setState({ showColliders: true });
    // Not saved: a link pins the lighting for this visit only (Settings saves it).
    if (phase && phase !== "auto" && (LIGHT_PINS as readonly string[]).includes(phase)) useStore.setState({ lightPin: phase as LightPin });
    if (view === "outside") useStore.setState({ startOutside: true });
    if (view === "walk" && canWalk()) useStore.getState().setViewMode("walk");
    if (open === "drive") openModal({ type: "drive" });
    else if (open?.startsWith("department:")) {
      const id = open.slice("department:".length);
      if (snapshot.departments.some((d) => d.id === id)) openModal({ type: "department", departmentId: id });
    } else if (open?.startsWith("file:") && open.length > "file:".length) {
      openModal({ type: "file", path: open.slice("file:".length) });
    }
    if (taskId && snapshot.tasks.some((t) => t.id === taskId)) selectTask(taskId);
    history.replaceState(null, "", location.pathname);
  }, [snapshot, openModal, selectTask]);

  // The raw snapshot: an approval from a hidden office task still counts while the AI office is off.
  useTabTitle(raw);

  if (!snapshot) {
    return (
      <div className="loading">
        <div className="loading__logo">🏢</div>
        <p>Opening the office…</p>
        <small>Waiting for the Siverse server. Is <code>npm run dev</code> running?</small>
      </div>
    );
  }

  return (
    <div className={`app${chatOpen ? " app--chat-open" : ""}${boardOpen ? " app--board-open" : ""}`}>
      <TopBar snapshot={snapshot} />
      <main className="app__body">
        <TaskBoard snapshot={snapshot} />
        <section className="app__scene">
          <ErrorBoundary name="3D office" resetKey={sceneKey} onClose={() => setSceneKey((k) => k + 1)} action="Reload 3D" center>
            <OfficeScene key={sceneKey} snapshot={snapshot} />
          </ErrorBoundary>
          <WelcomeBack />
          <WalkHud />
          <ErrorBoundary name="task card" resetKey={selectedTaskId} onClose={() => selectTask(null)}>
            {/* Off: the board hides office tasks, but a running worker can still ask for an OK, and the
                approval route doesn't need the office on. */}
            <TaskDetail snapshot={raw && !raw.settings.aiOffice ? raw : snapshot} />
          </ErrorBoundary>
        </section>
        <ChatPanel snapshot={snapshot} />
      </main>
      <ErrorBoundary name="window" resetKey={modal} onClose={() => openModal(null)}>
        <Modals snapshot={snapshot} />
      </ErrorBoundary>
      <Toasts />
    </div>
  );
}

/** With the AI office off, the office shows only what Claude Code is doing. */
function visibleSnapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.settings.aiOffice) return snapshot;
  return {
    ...snapshot,
    departments: snapshot.departments.filter(isClaudeCode),
    employees: [],
    tasks: snapshot.tasks.filter(isClaudeCode),
  };
}

/** "(2) Siverse": approvals waiting, plus tasks that finished while the tab was in the background. */
function useTabTitle(snapshot: Snapshot | null) {
  const unseen = useStore((s) => s.unseen);
  const asking = snapshot?.tasks.filter((t) => t.approval).length ?? 0;
  useEffect(() => {
    const count = asking + unseen;
    document.title = count ? `(${count}) Siverse` : "Siverse";
  }, [asking, unseen]);
  useEffect(() => {
    const back = () => {
      if (!document.hidden) useStore.setState({ unseen: 0 });
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const announcement = useStore((s) => s.announcement);
  return (
    <>
      {/* The one live region: toasts themselves stay silent so nothing is read twice. */}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} />
          ))}
        </div>
      )}
    </>
  );
}

const TOAST_MS = 4500;

/**
 * "· 4 min left" on the sticky approval toast: the soonest deadline of all open office asks (that's the one
 * about to be lost). Its own 15 s clock, because snapshots only arrive when something changes.
 */
function StickyLeft() {
  const soonest = useStore((s) =>
    Math.min(...(s.snapshot?.tasks ?? []).filter((t) => t.approval && !isClaudeCode(t)).map((t) => t.approval!.requestedAt)),
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!Number.isFinite(soonest)) return null;
  const left = minutesLeft(soonest, now);
  return (
    <span className={left <= URGENT_MINUTES ? "toast__urgent" : undefined}>
      {left <= 0 ? " · about to time out" : ` · ${left} min left`}
    </span>
  );
}

function Toast({ toast }: { toast: ToastItem }) {
  const dismissToast = useStore((s) => s.dismissToast);
  const selectTask = useStore((s) => s.selectTask);
  // The timer pauses while the toast is hovered or focused, so it can't vanish mid-read (WCAG 2.2.1).
  const left = useRef(TOAST_MS);
  const since = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pause = () => {
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    left.current -= Date.now() - since.current;
  };
  const resume = () => {
    if (timer.current !== undefined) return;
    since.current = Date.now();
    timer.current = setTimeout(() => dismissToast(toast.id), Math.max(1000, left.current));
  };
  useEffect(() => {
    if (!toast.sticky) resume();
    return pause;
  }, []);
  const hold = { onMouseEnter: pause, onMouseLeave: resume, onFocus: pause, onBlur: resume };
  const className = `toast toast--${toast.tone}`;
  // An approval stays until it's answered (store.syncAsk) or dismissed here: two buttons side by side.
  if (toast.sticky)
    return (
      <div className={className}>
        <button
          className="toast__open"
          onClick={() => {
            if (toast.taskId) selectTask(toast.taskId);
            dismissToast(toast.id);
          }}
        >
          {toast.text}
          <StickyLeft />
        </button>
        <button className="icon-btn toast__close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
          ✕
        </button>
      </div>
    );
  // Plain toasts get hover only: making them focusable would add tab stops that do nothing.
  if (!toast.taskId)
    return (
      <div className={className} onMouseEnter={pause} onMouseLeave={resume}>
        {toast.text}
      </div>
    );
  return (
    <button
      className={`${className} toast--link`}
      {...hold}
      onClick={() => {
        selectTask(toast.taskId!);
        dismissToast(toast.id);
      }}
    >
      {toast.text}
    </button>
  );
}

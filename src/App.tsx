import { useEffect, useMemo, useRef } from "react";
import type { Snapshot } from "../shared/types";
import { isClaudeCode } from "../shared/types";
import { OfficeScene } from "./scene/OfficeScene";
import { useStore } from "./store";
import { ChatPanel } from "./ui/ChatPanel";
import { Modals } from "./ui/Modals";
import { TaskBoard } from "./ui/TaskBoard";
import { TaskDetail } from "./ui/TaskDetail";
import { TopBar } from "./ui/TopBar";

export function App() {
  const raw = useStore((s) => s.snapshot);
  const snapshot = useMemo(() => raw && visibleSnapshot(raw), [raw]);
  const chatOpen = useStore((s) => s.chatOpen);
  const boardOpen = useStore((s) => s.boardOpen);
  const openModal = useStore((s) => s.openModal);

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
          <OfficeScene snapshot={snapshot} />
          <TaskDetail snapshot={snapshot} />
        </section>
        <ChatPanel snapshot={snapshot} />
      </main>
      <Modals snapshot={snapshot} />
      <Toast />
    </div>
  );
}

/** With the AI office off, the office shows only what Claude Code is doing. */
function visibleSnapshot(snapshot: Snapshot): Snapshot {
  if (snapshot.settings.aiOffice) return snapshot;
  return {
    ...snapshot,
    departments: snapshot.departments.filter(isClaudeCode),
    tasks: snapshot.tasks.filter(isClaudeCode),
  };
}

function Toast() {
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => useStore.setState({ toast: null }), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className={`toast toast--${toast.tone}`} role="status">
      {toast.text}
    </div>
  );
}

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import type { ChatMessage, Snapshot } from "../../shared/types";
import { api, useStore } from "../store";
import { claudeCodeIsLive } from "../claudeCode";
import { ClaudeCodeFeed } from "./ClaudeCodeFeed";

const SUGGESTIONS = [
  "Set up Marketing, Research and Engineering departments for a coffee subscription startup",
  "Ask Research to compare the 3 best project management tools for a 5-person team",
  "Have Marketing write a launch announcement and 3 social posts for our new app",
];

export function ChatPanel({ snapshot }: { snapshot: Snapshot }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const connected = useStore((s) => s.connected);
  const openModal = useStore((s) => s.openModal);
  const setChatOpen = useStore((s) => s.setChatOpen);
  const tab = useStore((s) => s.chatTab);
  const setTab = useStore((s) => s.setChatTab);
  const list = useRef<HTMLDivElement>(null);
  const { busy, activity } = snapshot.manager;
  const hasKey = Boolean(snapshot.settings.apiKeySource);
  const last = snapshot.chat.at(-1);

  // Keep the newest message in view as replies stream in.
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [snapshot.chat.length, last?.text, busy]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy || sending) return;
    setSending(true);
    try {
      await api("POST", "/api/chat", { text: trimmed });
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  const newDay = async () => {
    if (confirm("Start a new workday? The manager forgets this chat but keeps their notes about you.")) {
      await api("POST", "/api/new-day");
    }
  };

  const managerView = (
    <>
      <div className="chat__messages" ref={list}>
        {snapshot.chat.length === 0 && (
          <div className="chat__welcome">
            <h3>Welcome to your office, boss.</h3>
            <p>
              Tell your manager what you need. They'll set up departments and hand out tasks, and workers will
              come in to do real work. Everything they make is saved to the company drive.
            </p>
            <div className="chat__suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {snapshot.chat.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {busy && (
          <div className="chat__activity">
            <span className="dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            {activity ?? "Thinking"}
          </div>
        )}
      </div>

      {!hasKey && (
        <button className="chat__keyline" onClick={() => openModal({ type: "settings" })}>
          🔑 Add your Claude API key to start →
        </button>
      )}
      <form className="chat__composer" onSubmit={onSubmit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={busy ? "The manager is replying…" : "Give an order, e.g. “Open a Design department”"}
          rows={2}
          maxLength={8000}
          disabled={!connected}
        />
        <button className="btn btn--primary" type="submit" disabled={!draft.trim() || busy || sending || !connected}>
          Send
        </button>
      </form>
    </>
  );

  return (
    <aside className="chat" aria-label="Chat with your manager">
      <header className="panel-header">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "manager"} className="tab" onClick={() => setTab("manager")}>
            Manager
          </button>
          <button role="tab" aria-selected={tab === "claude-code"} className="tab" onClick={() => setTab("claude-code")}>
            <span className={`live-dot${claudeCodeIsLive(snapshot) ? " live-dot--on" : ""}`} />
            Claude Code
          </button>
        </div>
        <div className="panel-header__actions">
          {tab === "manager" && (
            <button className="btn btn--ghost btn--sm" onClick={newDay} disabled={busy} title="Clear the conversation">
              ☀️ New day
            </button>
          )}
          <button className="icon-btn hide-lg" onClick={() => setChatOpen(false)} aria-label="Close chat">
            ✕
          </button>
        </div>
      </header>

      {tab === "claude-code" ? (
        <>
          <ClaudeCodeFeed snapshot={snapshot} />
          <p className="chat__hint">Type your prompts in Claude Code. Siverse shows what happens in the office.</p>
        </>
      ) : (
        managerView
      )}
    </aside>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "system") {
    return <div className={`chat__system chat__system--${message.tone ?? "info"}`}>{message.text}</div>;
  }
  const mine = message.role === "boss";
  return (
    <div className={`msg ${mine ? "msg--boss" : "msg--manager"}${message.tone === "error" ? " msg--error" : ""}`}>
      {!mine && <span className="avatar avatar--manager avatar--sm">M</span>}
      <div className="msg__bubble">
        {mine ? (
          message.text
        ) : message.text ? (
          <Markdown>{message.text}</Markdown>
        ) : (
          <span className="msg__placeholder">…</span>
        )}
      </div>
    </div>
  );
}

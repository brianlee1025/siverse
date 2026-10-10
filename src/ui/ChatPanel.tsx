import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import type { ChatMessage, Snapshot } from "../../shared/types";
import { api, useStore } from "../store";
import { claudeCodeIsLive } from "../claudeCode";
import { useDraft } from "../drafts";
import { ClaudeCodeFeed } from "./ClaudeCodeFeed";

const SUGGESTIONS = [
  "Set up Marketing, Research and Engineering departments for a coffee subscription startup",
  "Ask Research to compare the 3 best project management tools for a 5-person team",
  "Have Marketing write a launch announcement and 3 social posts for our new app",
];

const HIDE_EVENTS_KEY = "siverse.hideOfficeEvents";
// Approval requests start with this (server/commands.ts:288); they stay visible when events are hidden.
const APPROVAL_PREFIX = "✋";
const GROUP_MIN = 3; // this many office events in a row fold into one line
const BOTTOM_SLACK_PX = 40;

type ChatItem = { kind: "message"; message: ChatMessage } | { kind: "events"; messages: ChatMessage[] };

/** Folds runs of consecutive office events so the boss's own conversation stays readable. */
function groupChat(chat: ChatMessage[], hideEvents: boolean): ChatItem[] {
  const items: ChatItem[] = [];
  let run: ChatMessage[] = [];
  const flush = () => {
    if (run.length >= GROUP_MIN) items.push({ kind: "events", messages: run });
    else for (const message of run) items.push({ kind: "message", message });
    run = [];
  };
  for (const message of chat) {
    if (message.role !== "system") {
      flush();
      items.push({ kind: "message", message });
    } else if (!hideEvents || message.tone === "error" || message.text.startsWith(APPROVAL_PREFIX)) {
      run.push(message);
    }
  }
  flush();
  return items;
}

function loadHideEvents(): boolean {
  try {
    return localStorage.getItem(HIDE_EVENTS_KEY) === "1";
  } catch {
    return false;
  }
}

export function ChatPanel({ snapshot }: { snapshot: Snapshot }) {
  const [draft, setDraft, clearDraft] = useDraft("chat");
  const [sending, setSending] = useState(false);
  const connected = useStore((s) => s.connected);
  const openModal = useStore((s) => s.openModal);
  const setChatOpen = useStore((s) => s.setChatOpen);
  const aiOffice = snapshot.settings.aiOffice;
  const selectedTab = useStore((s) => s.chatTab);
  const tab = aiOffice ? selectedTab : "claude-code";
  const setTab = useStore((s) => s.setChatTab);
  const list = useRef<HTMLDivElement>(null);
  const { busy, activity } = snapshot.manager;
  const ready = snapshot.settings.ready;
  const onClaudeCode = snapshot.settings.engine === "claude-code";
  const last = snapshot.chat.at(-1);
  const [hideEvents, setHideEvents] = useState(loadHideEvents);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const atBottom = useRef(true);
  const [newBelow, setNewBelow] = useState(false);

  const scrollDown = () => {
    // Instant, not smooth: a smooth scroll fires scroll events part-way, which would read as "scrolled up".
    list.current?.scrollTo({ top: list.current.scrollHeight });
    atBottom.current = true;
    setNewBelow(false);
  };

  // Follow new messages only if the boss is already at the bottom (or just sent one themselves).
  useEffect(() => {
    if (atBottom.current || last?.role === "boss") scrollDown();
    else setNewBelow(true);
  }, [snapshot.chat.length, last?.text, busy]);

  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    if (atBottom.current) setNewBelow(false);
  };

  const toggleHideEvents = (hide: boolean) => {
    setHideEvents(hide);
    try {
      localStorage.setItem(HIDE_EVENTS_KEY, hide ? "1" : "0");
    } catch {
      // Not saved; it still applies for this visit.
    }
  };

  const toggleGroup = (id: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const items = groupChat(snapshot.chat, hideEvents);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy || sending) return;
    setSending(true);
    try {
      await api("POST", "/api/chat", { text: trimmed });
      clearDraft();
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
      <div className="chat__messages" ref={list} onScroll={onScroll}>
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
        {items.map((item) =>
          item.kind === "message" ? (
            <Message key={item.message.id} message={item.message} />
          ) : (
            <EventGroup
              key={item.messages[0].id}
              messages={item.messages}
              open={expanded.has(item.messages[0].id)}
              onToggle={() => toggleGroup(item.messages[0].id)}
            />
          ),
        )}
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
        {newBelow && (
          <button className="chat__new-pill" onClick={scrollDown}>
            ↓ New messages
          </button>
        )}
      </div>

      {!ready && (
        <button className="chat__keyline" onClick={() => openModal({ type: "settings" })}>
          {onClaudeCode ? "⚡ Claude Code wasn't found on this computer. Check Settings →" : "🔑 Add your Claude API key to start →"}
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
        {aiOffice ? (
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "manager"} className="tab" onClick={() => setTab("manager")}>
              Manager
            </button>
            <button role="tab" aria-selected={tab === "claude-code"} className="tab" onClick={() => setTab("claude-code")}>
              <span className={`live-dot${claudeCodeIsLive(snapshot) ? " live-dot--on" : ""}`} />
              Claude Code
            </button>
          </div>
        ) : (
          <div className="chat__who">
            <span className="avatar avatar--claude">C</span>
            <div>
              <strong>Claude Code</strong>
              <small>{claudeCodeIsLive(snapshot) ? "live" : "waiting for a session"}</small>
            </div>
          </div>
        )}
        <div className="panel-header__actions">
          {tab === "manager" && (
            // An icon, not a labelled checkbox: with text, the header no longer fits on one line.
            <button
              className="icon-btn chat__hide-events"
              aria-pressed={hideEvents}
              onClick={() => toggleHideEvents(!hideEvents)}
              title={hideEvents ? "Show office events" : "Hide office events (approvals and errors stay)"}
              aria-label="Hide office events"
            >
              {hideEvents ? "🔕" : "🔔"}
            </button>
          )}
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

/** A run of office events: the newest in full, the rest behind a toggle. */
function EventGroup({ messages, open, onToggle }: { messages: ChatMessage[]; open: boolean; onToggle: () => void }) {
  const newest = messages[messages.length - 1];
  const earlier = messages.length - 1;
  return (
    <div className="chat__events">
      {open && messages.slice(0, -1).map((m) => <Message key={m.id} message={m} />)}
      <Message message={newest} />
      <button className="chat__events-toggle" onClick={onToggle} aria-expanded={open}>
        {open ? "Show less" : `+${earlier} earlier office event${earlier === 1 ? "" : "s"}`}
      </button>
    </div>
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

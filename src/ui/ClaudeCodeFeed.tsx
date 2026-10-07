import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { Snapshot } from "../../shared/types";
import { api, useStore } from "../store";

// A read-only mirror of your Claude Code conversations: what you asked and what Claude answered,
// across every project. You keep typing in Claude Code itself; Siverse shows the office side.
export function ClaudeCodeFeed({ snapshot }: { snapshot: Snapshot }) {
  const { feed, hooksInstalled, lastEventAt } = snapshot.claudeCode;
  // Project-level hooks don't show up in the user-level check, but their events do.
  const connected = hooksInstalled || lastEventAt !== null;
  const showToast = useStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [feed.length]);

  const connect = async () => {
    setBusy(true);
    try {
      const { file } = await api<{ file: string }>("POST", "/api/claude-code/connect");
      showToast(`Connected. Hooks added to ${file}. Start a new Claude Code session to see it here.`);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("Remove Siverse's hooks from your Claude Code settings?")) return;
    await api("POST", "/api/claude-code/disconnect");
    showToast("Disconnected from Claude Code.");
  };

  return (
    <div className="chat__messages" ref={list}>
      {!connected ? (
        <div className="chat__welcome">
          <h3>Watch Claude Code at work</h3>
          <p>
            Connect Siverse to Claude Code and every session shows up in the office: each project gets a zone, Claude
            sits at a desk, and every subagent it launches walks in as another worker.
          </p>
          <p>
            It works with your Claude Pro or Max plan. Siverse never calls Claude or sees your login. Claude Code
            just reports what it's doing through hooks in <code>~/.claude/settings.json</code>.
          </p>
          <button className="btn btn--primary" onClick={connect} disabled={busy}>
            ⚡ Connect Claude Code
          </button>
        </div>
      ) : feed.length === 0 ? (
        <div className="chat__welcome">
          <h3>Connected ⚡</h3>
          <p>
            Start a <strong>new</strong> Claude Code session (or restart an open one) and give it a task. It will
            appear in the office as soon as it starts working.
          </p>
          {hooksInstalled && (
            <button className="btn btn--ghost btn--sm" onClick={disconnect}>
              Disconnect
            </button>
          )}
        </div>
      ) : (
        feed.map((item) => (
          <div key={item.id} className={`msg ${item.role === "you" ? "msg--boss" : "msg--manager"}`}>
            {item.role === "claude" && <span className="avatar avatar--claude avatar--sm">C</span>}
            <div className="msg__bubble">
              <small className="msg__project">{item.project}</small>
              {item.role === "you" ? item.text : <Markdown>{item.text}</Markdown>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

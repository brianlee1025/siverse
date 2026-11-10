import { create } from "zustand";
import { isClaudeCode, type ServerMessage, type Snapshot } from "../shared/types";
import { createTaskWatcher, share } from "./snapshot";

export type Modal =
  | { type: "settings" }
  | { type: "department"; departmentId: string | null } // null = create a new one
  | { type: "drive" }
  | { type: "file"; path: string };

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "ask";
  taskId?: string; // clicking the toast opens this task
  sticky?: boolean; // stays until the approval is answered or the boss dismisses it
}

/** Office tasks waiting for the boss's OK, oldest first. */
function asking(snapshot: Snapshot | null) {
  return (snapshot?.tasks ?? []).filter((t) => t.approval && !isClaudeCode(t));
}

const askText = (n: number, text: string) => (n > 1 ? `✋ ${n} need your OK` : text);

/** Same wording as the watcher's "ask" event (src/snapshot.ts). */
function askLine(task: Snapshot["tasks"][number], snapshot: Snapshot) {
  const department = snapshot.departments.find((d) => d.id === task.departmentId)?.name ?? "A department";
  return `✋ ${task.workerName ?? department} needs your OK`;
}

/** At most MAX_TOASTS plain toasts; sticky ones never count, so quick "done" toasts can't push an approval out. */
function capped(toasts: Toast[]) {
  const plain = toasts.filter((t) => !t.sticky).slice(-MAX_TOASTS);
  return toasts.filter((t) => t.sticky || plain.includes(t));
}

const MAX_TOASTS = 3;
const SEEN_FAILED_KEY = "siverse.seenFailed";
const MAX_SEEN_FAILED = 200;

/** Failed tasks the boss has already opened, so they leave "Needs you". Kept across reloads. */
function loadSeenFailed(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(SEEN_FAILED_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveSeenFailed(ids: string[]) {
  try {
    localStorage.setItem(SEEN_FAILED_KEY, JSON.stringify(ids));
  } catch {
    // Private mode or full storage: the set just won't survive a reload.
  }
}

interface UIState {
  snapshot: Snapshot | null;
  connected: boolean;
  selectedTaskId: string | null;
  modal: Modal | null;
  toasts: Toast[];
  announcement: string; // the latest toast, for screen readers
  unseen: number; // tasks finished or failed while the tab was hidden
  chatOpen: boolean; // only matters on narrow screens
  boardOpen: boolean;
  chatTab: "manager" | "claude-code";
  seenFailed: string[];
  selectTask: (id: string | null) => void;
  markFailedSeen: (ids: string[]) => void;
  openModal: (modal: Modal | null) => void;
  showToast: (text: string, tone?: Toast["tone"], taskId?: string) => void;
  showAsk: (text: string, taskId: string) => void;
  syncAsk: (snapshot: Snapshot) => void;
  dismissToast: (id: number) => void;
  setChatOpen: (open: boolean) => void;
  setBoardOpen: (open: boolean) => void;
  setChatTab: (tab: UIState["chatTab"]) => void;
}

let nextToastId = 1;

export const useStore = create<UIState>((set, get) => ({
  snapshot: null,
  connected: false,
  selectedTaskId: null,
  modal: null,
  toasts: [],
  announcement: "",
  unseen: 0,
  chatOpen: false,
  boardOpen: false,
  chatTab: "manager",
  seenFailed: loadSeenFailed(),
  selectTask: (selectedTaskId) => {
    set({ selectedTaskId });
    const task = get().snapshot?.tasks.find((t) => t.id === selectedTaskId);
    if (task?.status === "failed") get().markFailedSeen([task.id]);
  },
  markFailedSeen: (ids) => {
    const fresh = ids.filter((id) => !get().seenFailed.includes(id));
    if (!fresh.length) return;
    const seenFailed = [...get().seenFailed, ...fresh].slice(-MAX_SEEN_FAILED);
    saveSeenFailed(seenFailed);
    set({ seenFailed });
  },
  openModal: (modal) => set({ modal }),
  showToast: (text, tone = "info", taskId) =>
    set((s) => ({
      toasts: capped([...s.toasts, { id: nextToastId++, text, tone, taskId }]),
      announcement: text,
    })),
  // One sticky toast for every approval: a second ask updates it to "✋ 2 need your OK".
  showAsk: (text, taskId) =>
    set((s) => {
      const sticky = s.toasts.find((t) => t.sticky);
      const n = asking(s.snapshot).length;
      return {
        toasts: sticky
          ? s.toasts.map((t) => (t === sticky ? { ...t, text: askText(n, text), taskId } : t))
          : capped([...s.toasts, { id: nextToastId++, text, tone: "ask", taskId, sticky: true }]),
        announcement: text,
      };
    }),
  // Runs on every snapshot. Only updates or removes the sticky toast: a dismissed one stays gone until the next ask.
  syncAsk: (snapshot) =>
    set((s) => {
      const sticky = s.toasts.find((t) => t.sticky);
      if (!sticky) return s;
      const tasks = asking(snapshot);
      if (!tasks.length) return { toasts: s.toasts.filter((t) => t !== sticky) };
      const target = tasks.find((t) => t.id === sticky.taskId) ?? tasks[0];
      const text = askText(tasks.length, askLine(target, snapshot));
      if (text === sticky.text && target.id === sticky.taskId) return s;
      return { toasts: s.toasts.map((t) => (t === sticky ? { ...t, text, taskId: target.id } : t)) };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  setBoardOpen: (boardOpen) => set({ boardOpen }),
  setChatTab: (chatTab) => set({ chatTab }),
}));

/** Keeps a WebSocket open to the server and mirrors its snapshots into the store. */
export function connect() {
  let retry = 0;
  let droppedAt = 0; // when the line went down, until the first snapshot after it comes back
  let firstSnapshot = true; // since the page loaded
  const watcher = createTaskWatcher();
  const open = () => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      watcher.reconnected(); // no-op on the first load: the watcher hasn't seen anything yet
      useStore.setState({ connected: true });
    };
    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return; // A broken frame: the next snapshot is only moments away.
      }
      if (message.type !== "snapshot") return;
      const previous = useStore.getState().snapshot;
      const snapshot = share(previous, message.data);
      const events = watcher.update(snapshot);
      if (snapshot !== previous) useStore.setState({ snapshot });
      const { showToast, showAsk, syncAsk } = useStore.getState();
      const outage = droppedAt ? Date.now() - droppedAt : 0;
      droppedAt = 0;
      for (const e of events) {
        if (e.summary) {
          const { finished, interrupted, failed, asking } = e.summary;
          // A short blip where nothing changed stays quiet.
          if (outage < 3000 && !finished && !interrupted && !failed && !asking) continue;
          showToast(e.text, interrupted || failed ? "error" : "info", e.taskId || undefined);
          const count = finished + interrupted + failed;
          if (document.hidden && count) useStore.setState((s) => ({ unseen: s.unseen + count }));
          continue;
        }
        if (e.kind === "ask") {
          showAsk(e.text, e.taskId);
          continue;
        }
        showToast(e.text, e.kind === "failed" || e.kind === "timeout" ? "error" : "info", e.taskId);
        if (document.hidden) useStore.setState((s) => ({ unseen: s.unseen + 1 }));
      }
      // A page load only seeds the watcher, and a reconnect folds asks into the "back" toast: neither calls
      // showAsk. So an approval already waiting gets its sticky toast here. (A dismissed one comes back after a blip.)
      if (firstSnapshot || events.some((e) => e.summary)) {
        const waiting = asking(snapshot);
        if (waiting.length && !useStore.getState().toasts.some((t) => t.sticky)) showAsk(askLine(waiting[0], snapshot), waiting[0].id);
      }
      firstSnapshot = false;
      syncAsk(snapshot);
    };
    ws.onclose = () => {
      if (!droppedAt) droppedAt = Date.now();
      useStore.setState({ connected: false });
      setTimeout(open, Math.min(8000, 500 * 2 ** retry++));
    };
  };
  open();
}

/** Calls the local API. Failures show a toast and throw. */
export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data as { error?: string }).error ?? `Request failed (${response.status})`;
    useStore.getState().showToast(message, "error");
    throw new Error(message);
  }
  return data as T;
}

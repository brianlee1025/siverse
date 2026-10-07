import { create } from "zustand";
import type { ServerMessage, Snapshot } from "../shared/types";

export type Modal =
  | { type: "settings" }
  | { type: "department"; departmentId: string | null } // null = create a new one
  | { type: "drive" }
  | { type: "file"; path: string };

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

interface UIState {
  snapshot: Snapshot | null;
  connected: boolean;
  selectedTaskId: string | null;
  modal: Modal | null;
  toast: Toast | null;
  chatOpen: boolean; // only matters on narrow screens
  boardOpen: boolean;
  selectTask: (id: string | null) => void;
  openModal: (modal: Modal | null) => void;
  showToast: (text: string, tone?: Toast["tone"]) => void;
  setChatOpen: (open: boolean) => void;
  setBoardOpen: (open: boolean) => void;
}

export const useStore = create<UIState>((set) => ({
  snapshot: null,
  connected: false,
  selectedTaskId: null,
  modal: null,
  toast: null,
  chatOpen: false,
  boardOpen: false,
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  openModal: (modal) => set({ modal }),
  showToast: (text, tone = "info") => set({ toast: { id: Date.now(), text, tone } }),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  setBoardOpen: (boardOpen) => set({ boardOpen }),
}));

/** Keeps a WebSocket open to the server and mirrors its snapshots into the store. */
export function connect() {
  let retry = 0;
  const open = () => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      useStore.setState({ connected: true });
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === "snapshot") useStore.setState({ snapshot: message.data });
    };
    ws.onclose = () => {
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

// Types shared by the server and the browser. The server owns all state and
// pushes a full Snapshot over the WebSocket whenever something changes.

export type TaskStatus = "queued" | "working" | "done" | "failed" | "cancelled";

export interface Department {
  id: string; // url-safe slug, also the department's folder name in the company drive
  name: string;
  genre: string; // the kind of work this department takes on, e.g. "copywriting & social posts"
  description: string; // standing instructions for every worker in this department
  color: string;
  headcount: number; // max workers at the same time = max tasks running at once
  webAccess: boolean;
  createdAt: number;
}

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface Task {
  id: string;
  departmentId: string;
  title: string;
  brief: string;
  status: TaskStatus;
  workerName?: string;
  deskIndex?: number;
  activity: string[]; // newest last; what the worker is doing, shown as speech bubbles
  outputs: string[]; // company-drive paths the worker wrote
  summary?: string;
  error?: string;
  usage: TaskUsage;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export type ChatRole = "boss" | "manager" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
  streaming?: boolean;
  tone?: "info" | "success" | "error";
}

export interface SettingsView {
  companyName: string;
  apiKeySource: "env" | "settings" | null;
  apiKeyHint: string | null; // last 4 characters, never the key itself
  managerModel: string;
  workerModel: string;
}

export interface Snapshot {
  settings: SettingsView;
  departments: Department[];
  tasks: Task[];
  chat: ChatMessage[];
  manager: { busy: boolean; activity: string | null };
  maxConcurrentWorkers: number;
}

export type ServerMessage = { type: "snapshot"; data: Snapshot };

export const MODEL_OPTIONS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (cheaper)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable)" },
] as const;

export const MAX_HEADCOUNT = 6;

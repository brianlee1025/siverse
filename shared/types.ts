// Types shared by the server and the browser. The server owns all state and
// pushes a full Snapshot over the WebSocket whenever something changes.

export type TaskStatus = "queued" | "working" | "done" | "failed" | "cancelled";

// "office" items are run by Siverse's own agents through the Claude API. "claude-code" items
// mirror what your own Claude Code sessions are doing, reported by Claude Code hooks; Siverse
// never calls Claude for those.
export type Source = "office" | "claude-code";

export interface Department {
  id: string; // url-safe slug, also the department's folder name in the company drive
  name: string;
  genre: string; // the kind of work this department takes on, e.g. "copywriting & social posts"
  description: string; // standing instructions for every worker in this department
  color: string;
  headcount: number; // max workers at the same time = max tasks running at once
  webAccess: boolean;
  createdAt: number;
  source?: Source; // missing = "office"
  projectPath?: string; // claude-code: the project folder the sessions run in
}

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

// Who does the office's work. "api": Siverse's own agents on the Claude API, billed to an
// API key. "claude-code": each worker (and the manager) is a run of the Claude Code CLI on this
// computer, on the boss's own Claude plan.
export type Engine = "api" | "claude-code";

// When a recurring task comes round, in the server's local time.
export type ScheduleCadence =
  | { kind: "daily"; time: string } // "09:00"
  | { kind: "weekly"; day: number; time: string } // day: 0 = Sunday … 6 = Saturday
  | { kind: "interval"; hours: number }; // every N hours from when it was set up

export interface Schedule {
  id: string;
  departmentId: string;
  title: string;
  brief: string;
  cadence: ScheduleCadence;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastTaskId?: string;
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
  source?: Source; // missing = "office"
  kind?: "session" | "subagent"; // claude-code only
  sessionId?: string; // claude-code only
  scheduleId?: string; // started by a recurring schedule
  engine?: Engine; // who ran it; missing = "api"
  costUsd?: number; // claude-code engine: what Claude Code reports the run would cost on the API
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
  aiOffice: boolean; // Siverse's own API-powered manager and workers are switched on
  apiKeySource: "env" | "settings" | null;
  apiKeyHint: string | null; // last 4 characters, never the key itself
  managerModel: string;
  workerModel: string;
  engine: Engine;
  claudeCodeCli: { path: string | null; version: string | null }; // the Claude Code CLI on this computer
  ready: boolean; // the chosen engine can run work right now
}

export interface FeedItem {
  id: string;
  role: "you" | "claude";
  project: string;
  text: string;
  at: number;
}

export interface ClaudeCodeView {
  hooksInstalled: boolean; // Siverse hooks found in ~/.claude/settings.json
  lastEventAt: number | null;
  feed: FeedItem[]; // your prompts and Claude's replies, newest last
}

export interface Snapshot {
  settings: SettingsView;
  departments: Department[];
  tasks: Task[];
  schedules: Schedule[];
  chat: ChatMessage[];
  manager: { busy: boolean; activity: string | null };
  maxConcurrentWorkers: number;
  claudeCode: ClaudeCodeView;
}

export type ServerMessage = { type: "snapshot"; data: Snapshot };

export const MODEL_OPTIONS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (cheaper)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable)" },
] as const;

export const MAX_HEADCOUNT = 6;

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "Every Monday at 09:00", "Every day at 18:30", "Every 6 hours". */
export function describeCadence(cadence: ScheduleCadence): string {
  switch (cadence.kind) {
    case "daily":
      return `Every day at ${cadence.time}`;
    case "weekly":
      return `Every ${WEEKDAYS[cadence.day] ?? "week"} at ${cadence.time}`;
    case "interval":
      return cadence.hours === 1 ? "Every hour" : `Every ${cadence.hours} hours`;
  }
}

export const isClaudeCode = (item: { source?: Source }) => item.source === "claude-code";

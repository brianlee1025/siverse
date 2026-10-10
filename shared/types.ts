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
  // Claude Code engine: its workers may also change Siverse's own code (except data, secrets and
  // the code that enforces approvals). Only the boss can switch this on, in the department window.
  codeAccess?: boolean;
  // This department's workers run on this model and effort. Missing = the office's worker model,
  // and the engine's usual effort (medium on the API, Claude Code's own default on the boss's plan).
  model?: string;
  effort?: Effort;
  createdAt: number;
  source?: Source; // missing = "office"
  projectPath?: string; // claude-code: the project folder the sessions run in
}

// A permanent member of a department: they keep one desk, focus on their own area of the
// department's work, and keep their own notes from task to task. The department's other desks are
// for temps, who come in for one task and only share the department's notes.
export interface Employee {
  id: string; // also the name of their notes folder
  departmentId: string;
  name: string;
  focus: string; // their area, e.g. "competitor pricing" or "the mobile app"
  deskIndex: number;
  hiredAt: number;
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
  | { kind: "interval"; hours: number } // every N hours from when it was set up
  | { kind: "after"; scheduleId: string }; // right after that schedule's task finishes successfully

export interface Schedule {
  id: string;
  departmentId: string;
  employeeId?: string; // always run by this employee; missing = whoever is free
  title: string;
  brief: string;
  cadence: ScheduleCadence;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastTaskId?: string;
}

// A command the boss has approved for one department, e.g. a script that sends the emails the
// department wrote. Workers have no shell: they ask Siverse to run it, Siverse runs the approved
// copy of the script (which workers can't edit) with only the environment variables named here,
// and, depending on askFirst, waits for the boss's OK on the task first.
export type AskFirst = "always" | "with-args" | "never";

export interface ApprovedCommand {
  id: string;
  departmentId: string;
  name: string; // what workers call it, e.g. "send_email"
  description: string; // what it does and when to use it, for the workers
  program: string; // what runs the script, e.g. "python", "py" or "node"
  script: string; // drive path it was approved from, e.g. "research/emails/send_email.py"
  scriptHash: string; // sha256 of the approved copy
  approvedAt: number;
  askFirst: AskFirst; // "with-args": running it bare (e.g. a dry run) needs no OK
  secrets: string[]; // names of the environment variables it gets, never their values
}

export interface CommandView extends ApprovedCommand {
  scriptChanged: boolean; // the script on the drive is no longer the approved version
  missingSecrets: string[]; // named variables that aren't set
}

// A worker waiting for the boss's OK to run a command.
export interface CommandApproval {
  commandId: string;
  commandLine: string; // e.g. "py send_email.py --send --limit 20"
  reason: string; // the worker's reason
  requestedAt: number;
}

export interface CommandRun {
  name: string;
  args: string[];
  askedBoss: boolean;
  outcome: "ok" | "failed" | "denied" | "no-answer" | "error";
  exitCode?: number | null;
  at: number;
}

// A follow-up conversation on a task: the boss asks for more, and the same worker carries on.
export interface TaskMessage {
  role: "boss" | "worker";
  text: string;
  at: number;
}

export interface Task {
  id: string;
  departmentId: string;
  title: string;
  brief: string;
  status: TaskStatus;
  employeeId?: string; // for (and, once started, done by) this permanent employee
  workerName?: string;
  deskIndex?: number;
  activity: string[]; // newest last; what the worker is doing, shown as speech bubbles
  outputs: string[]; // company-drive paths the worker wrote
  summary?: string; // the worker's latest reply
  thread?: TaskMessage[]; // once the boss follows up: the first result, then each follow-up and reply
  approval?: CommandApproval; // waiting for the boss's OK to run a command
  commandRuns?: CommandRun[];
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

// How much of a Claude plan usage limit is used, as Claude Code reports it.
export interface UsageWindow {
  usedPercent: number; // 0-100
  resetsAt: number; // ms
}

// Your Claude plan, from the Claude Code CLI on this computer. Usage comes from Claude Code's own
// rate-limit reports on headless runs, so it is as fresh as the last run (updatedAt).
export interface PlanView {
  cli: boolean; // a Claude Code CLI was found
  signedIn: boolean | null; // null = not checked yet
  plan: string | null; // e.g. "pro", "max", as Claude Code reports it; null for API-key logins
  fiveHour: UsageWindow | null; // null = unknown, or the window has reset since
  sevenDay: UsageWindow | null;
  limited: boolean; // a limit was reached at the last report
  updatedAt: number | null;
  checking: boolean;
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
  employees: Employee[];
  tasks: Task[];
  schedules: Schedule[];
  commands: CommandView[];
  chat: ChatMessage[];
  manager: { busy: boolean; activity: string | null };
  maxConcurrentWorkers: number;
  claudeCode: ClaudeCodeView;
  plan: PlanView;
}

export type ServerMessage = { type: "snapshot"; data: Snapshot };

export const MODEL_OPTIONS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (cheaper)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable)" },
] as const;

// How hard a worker thinks: higher is more thorough, slower, and uses more of the plan or budget.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

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
    case "after":
      return "After another recurring task";
  }
}

export const isClaudeCode = (item: { source?: Source }) => item.source === "claude-code";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { DATA_DIR, ROOT_DIR } from "./config";

// The Claude Code CLI on this computer, which the "claude-code" engine runs headless (`claude -p`)
// for every worker and for the manager. It runs on the boss's own Claude login and plan, exactly as
// if they had typed the prompt themselves; Siverse never sees the login.
//
// The desktop app ships its own copy in a folder that changes with every update
// (…/Claude/claude-code/<version>/<build>/claude.exe), so it is looked up again from time to time.

export interface ClaudeCli {
  path: string;
  version: string;
  shell: boolean; // a .cmd/.bat wrapper (npm install on Windows) has to go through the shell
}

const RECHECK_MS = 5 * 60_000;
let cached: { at: number; cli: ClaudeCli | null } = { at: 0, cli: null };

/** The CLI to run, or null when none is installed. CLAUDE_CODE_BIN overrides the search. */
export function findClaudeCli(): ClaudeCli | null {
  if (Date.now() - cached.at < RECHECK_MS) return cached.cli;
  cached = { at: Date.now(), cli: search() };
  return cached.cli;
}

export function forgetClaudeCli() {
  cached.at = 0;
}

function search(): ClaudeCli | null {
  for (const candidate of candidates()) {
    const cli = probe(candidate);
    if (cli) return cli;
  }
  return null;
}

function candidates(): string[] {
  const list: string[] = [];
  if (process.env.CLAUDE_CODE_BIN?.trim()) list.push(process.env.CLAUDE_CODE_BIN.trim());
  list.push(...onPath());
  list.push(...desktopAppCopies());
  const home = os.homedir();
  list.push(path.join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"));
  list.push(path.join(home, ".claude", "local", process.platform === "win32" ? "claude.exe" : "claude"));
  return [...new Set(list)];
}

function onPath(): string[] {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["claude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** The copies the Claude desktop app keeps, newest first. */
function desktopAppCopies(): string[] {
  const roots =
    process.platform === "win32"
      ? [path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude-code")]
      : process.platform === "darwin"
        ? [path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code")]
        : [path.join(os.homedir(), ".config", "Claude", "claude-code")];
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const found: { file: string; mtime: number }[] = [];
  for (const root of roots) {
    for (const version of safeList(root)) {
      const versionDir = path.join(root, version);
      for (const build of safeList(versionDir)) {
        const file = path.join(versionDir, build, exe);
        try {
          found.push({ file, mtime: fs.statSync(file).mtimeMs });
        } catch {
          // Not a build folder.
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.file);
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Accepts the file only if it answers `--version` as Claude Code (the desktop app is also claude.exe). */
function probe(file: string): ClaudeCli | null {
  if (!fs.existsSync(file)) return null;
  const shell = /\.(cmd|bat)$/i.test(file);
  try {
    const out = execFileSync(shell ? `"${file}"` : file, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      shell,
      windowsHide: true,
    });
    if (!/claude code/i.test(out)) return null;
    return { path: file, version: out.match(/\d+\.\d+\.\d+/)?.[0] ?? out.trim(), shell };
  } catch {
    return null;
  }
}

// ---- running it ---------------------------------------------------------------------------

/** One line of `--output-format stream-json`. Only the fields Siverse reads are typed. */
export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  // type "result":
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  // type "rate_limit_event": the account's plan usage, reported on every run.
  rate_limit_info?: RateLimitInfo;
}

export interface RateLimitInfo {
  status?: string; // "allowed", "allowed_warning" or "rejected"
  resetsAt?: number;
  rateLimitType?: string; // "five_hour", "seven_day", …
  utilization?: number; // 0-1, for rateLimitType
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
}

const rateLimitListeners = new Set<(info: RateLimitInfo) => void>();

/** Called with every rate-limit report from any Claude Code run Siverse starts. */
export function onRateLimit(listener: (info: RateLimitInfo) => void) {
  rateLimitListeners.add(listener);
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; is_error?: boolean; content?: unknown };

export interface RunOptions {
  cwd: string;
  prompt: string; // sent on stdin, never on the command line
  args: string[]; // fixed flags only: no text that came from the boss or a model
  env?: Record<string, string>; // added to the environment
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

export class ClaudeCliError extends Error {}

/** A permission-rule path for a file: absolute, POSIX form, e.g. "//c/Users/me/siverse/.env". */
export function rulePath(file: string) {
  let posix = path.resolve(file).split(path.sep).join("/");
  const drive = /^([A-Za-z]):\//.exec(posix);
  if (drive) posix = `/${drive[1].toLowerCase()}/${posix.slice(3)}`;
  return `/${posix}`;
}

/**
 * Deny rules for every Claude Code run Siverse starts: its file tools can't read or change
 * Siverse's secrets (.env, where approved commands' passwords live, and the saved API key), and
 * can't change the approved copies of command scripts.
 */
export function protectedFileRules(): string[] {
  const secrets = [path.join(ROOT_DIR, ".env"), path.join(ROOT_DIR, ".env.local"), path.join(DATA_DIR, "settings.json")];
  return [
    ...secrets.flatMap((file) => [`Read(${rulePath(file)})`, `Edit(${rulePath(file)})`]),
    `Edit(${rulePath(path.join(DATA_DIR, "tools"))}/**)`,
  ];
}

// What a department with code access still can't change: Siverse's data and secrets, git and
// dependencies, and the code that enforces approvals and these rules. This stops accidents, not a
// determined worker: any server file runs inside Siverse.
const PROTECTED_CODE = [
  "data/**", ".env*", ".git/**", "node_modules/**", ".claude/**", "package.json", "package-lock.json",
  "server/commands.ts", "server/claudeCli.ts", "server/ccWorker.ts", "server/ccManager.ts", "server/security.ts",
  "scripts/siverse-worker-mcp.mjs", "scripts/siverse-mcp.mjs",
];

export const protectedCodePaths = () =>
  PROTECTED_CODE.map((p) => (p === "data/**" ? "data/ (except your notes folders)" : p.replace("/**", "/")));

/**
 * Deny rules for a department with code access: everything above, which deny rules always win over.
 * `notesDirs`, the worker's own notes folders inside data/, stay writable.
 */
export function protectedCodeRules(notesDirs: string[] = []): string[] {
  return PROTECTED_CODE.flatMap((p) => (p === "data/**" ? dataRules(notesDirs) : [`Edit(${rulePath(ROOT_DIR)}/${p})`]));
}

/**
 * data/ minus the given folders. A deny rule can't have exceptions, so this denies each of data/'s
 * other entries instead, going down only into folders that hold a kept one (e.g. data/memory/).
 */
function dataRules(keep: string[]): string[] {
  const kept = keep.map((dir) => path.resolve(dir));
  const isInside = (child: string, parent: string) => {
    const relative = path.relative(parent, child);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  if (!kept.some((dir) => isInside(dir, DATA_DIR))) return [`Edit(${rulePath(DATA_DIR)}/**)`];
  // Also data/'s own files that don't exist yet; `*` doesn't reach into subfolders.
  const rules = [`Edit(${rulePath(DATA_DIR)}/*.json)`];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (kept.some((k) => path.relative(k, full) === "")) continue;
      if (entry.isDirectory() && kept.some((k) => isInside(k, full))) walk(full);
      else rules.push(`Edit(${rulePath(full)}${entry.isDirectory() ? "/**" : ""})`);
    }
  };
  walk(DATA_DIR);
  return rules;
}

let hiddenEnv: () => string[] = () => [];

/** Environment variables Claude Code runs must never get, e.g. the secrets of approved commands. */
export function hideFromClaudeCode(names: () => string[]) {
  hiddenEnv = names;
}

function claudeCodeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SIVERSE_RUN: "1", ...extra };
  const hidden = new Set(hiddenEnv().map((n) => n.toUpperCase()));
  for (const name of Object.keys(env)) if (hidden.has(name.toUpperCase())) delete env[name];
  return env;
}

/** Runs `claude -p` to the end and returns its final "result" event. */
export function runClaudeCli(options: RunOptions): Promise<StreamEvent> {
  const cli = findClaudeCli();
  if (!cli) {
    return Promise.reject(new ClaudeCliError("Claude Code isn't installed on this computer, or Siverse can't find it. Set CLAUDE_CODE_BIN to its path."));
  }
  fs.mkdirSync(options.cwd, { recursive: true });
  const args = ["-p", "--output-format", "stream-json", "--verbose", ...options.args];

  return new Promise((resolve, reject) => {
    const child = spawn(cli.shell ? `"${cli.path}"` : cli.path, cli.shell ? args.map(quoteForShell) : args, {
      cwd: options.cwd,
      env: claudeCodeEnv(options.env),
      shell: cli.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let result: StreamEvent | undefined;
    let buffer = "";
    let stderr = "";
    const onAbort = () => child.kill();
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: StreamEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // Not an event line.
        }
        if (event.type === "result") result = event;
        if (event.type === "rate_limit_event" && event.rate_limit_info) {
          for (const listener of rateLimitListeners) listener(event.rate_limit_info);
        }
        try {
          options.onEvent(event);
        } catch (error) {
          console.error("[claude-code engine]", error);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on("error", (error) => {
      options.signal.removeEventListener("abort", onAbort);
      reject(new ClaudeCliError(`Couldn't start Claude Code: ${error.message}`));
    });
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", onAbort);
      if (options.signal.aborted) return reject(new ClaudeCliError("Cancelled."));
      if (result) return resolve(result);
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
      reject(new ClaudeCliError(`Claude Code stopped (exit ${code ?? "?"}) without finishing${detail ? `: ${detail}` : "."}`));
    });

    child.stdin.on("error", () => {
      // The CLI exited before reading its prompt; the close handler reports why.
    });
    child.stdin.end(options.prompt);
  });
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string | null;
}

/** `claude auth status`: whether the CLI is signed in, and to which kind of plan. Null without a CLI. */
export function readAuthStatus(): Promise<AuthStatus | null> {
  const cli = findClaudeCli();
  if (!cli) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      cli.shell ? `"${cli.path}"` : cli.path,
      ["auth", "status"],
      { encoding: "utf8", timeout: 15_000, shell: cli.shell, windowsHide: true },
      // It can exit non-zero when signed out, with the same JSON on stdout.
      (_error, stdout) => {
        try {
          const status = JSON.parse(stdout.slice(stdout.indexOf("{")));
          resolve({ loggedIn: Boolean(status.loggedIn), authMethod: status.authMethod, subscriptionType: status.subscriptionType ?? null });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Only used for a .cmd wrapper: every argument is ours, but paths can contain spaces. */
function quoteForShell(arg: string) {
  return arg === "" || /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** The message of a failed result event, in plain words. */
export function resultError(event: StreamEvent): string {
  if (event.subtype === "error_max_turns") return "The worker hit Claude Code's turn limit before finishing. Try splitting the task.";
  const text = (event.result ?? "").trim();
  if (/usage limit|rate limit|limit reached/i.test(text)) return `Your Claude plan's usage limit was reached: ${text.slice(0, 200)}`;
  if (/log ?in|authenticat/i.test(text)) return `Claude Code isn't signed in. Open Claude Code once and sign in. (${text.slice(0, 160)})`;
  return text.slice(0, 400) || `Claude Code reported an error (${event.subtype ?? "unknown"}).`;
}

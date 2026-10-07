import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

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
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

export class ClaudeCliError extends Error {}

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
      env: { ...process.env, SIVERSE_RUN: "1" },
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

/** Only used for a .cmd wrapper: every argument is ours, but paths can contain spaces. */
function quoteForShell(arg: string) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/** The message of a failed result event, in plain words. */
export function resultError(event: StreamEvent): string {
  if (event.subtype === "error_max_turns") return "The worker hit Claude Code's turn limit before finishing. Try splitting the task.";
  const text = (event.result ?? "").trim();
  if (/usage limit|rate limit|limit reached/i.test(text)) return `Your Claude plan's usage limit was reached: ${text.slice(0, 200)}`;
  if (/log ?in|authenticat/i.test(text)) return `Claude Code isn't signed in. Open Claude Code once and sign in. (${text.slice(0, 160)})`;
  return text.slice(0, 400) || `Claude Code reported an error (${event.subtype ?? "unknown"}).`;
}

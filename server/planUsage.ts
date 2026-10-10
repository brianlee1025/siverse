import fs from "node:fs";
import path from "node:path";
import type { PlanView, UsageWindow } from "../shared/types";
import { ClaudeCliError, findClaudeCli, onRateLimit, readAuthStatus, resultError, runClaudeCli, type RateLimitInfo } from "./claudeCli";
import { DATA_DIR } from "./config";
import { changed } from "./store";

// Your Claude plan and how much of its usage limits is left, for the top bar. Everything comes
// from the Claude Code CLI on this computer; Siverse never reads its login.
// - The plan comes from `claude auth status`.
// - Usage comes from the rate-limit report Claude Code makes on every headless run: the office's
//   own runs, or a tiny check when the boss asks for one. Limits are per account, so it covers
//   all your Claude use, but it is only as fresh as the last run.

const USAGE_FILE = path.join(DATA_DIR, "plan-usage.json");
const AUTH_RECHECK_MS = 10 * 60_000;
const CHECK_DIR = path.join(DATA_DIR, "usage-check");

interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  limited: boolean;
  updatedAt: number | null;
}

let usage: Usage = { fiveHour: null, sevenDay: null, limited: false, updatedAt: null };
let auth: { signedIn: boolean | null; plan: string | null } = { signedIn: null, plan: null };
let checking = false;

function loadUsage() {
  try {
    usage = { ...usage, ...JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")) };
  } catch {
    // Nothing reported yet.
  }
}

function saveUsage() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch (error) {
    console.error("[plan usage]", error);
  }
}

/** Claude Code has sent reset times in seconds; be ready for milliseconds too. */
const toMs = (time: number) => (time < 1e12 ? time * 1000 : time);

function toWindow(utilization: number | undefined, resetsAt: number | undefined): UsageWindow | null {
  if (typeof utilization !== "number" || typeof resetsAt !== "number") return null;
  return { usedPercent: Math.min(100, Math.max(0, utilization * 100)), resetsAt: toMs(resetsAt) };
}

function record(info: RateLimitInfo) {
  const windows = info.unifiedWindows ?? {};
  // Newer reports carry both windows; older ones only the window that applies right now.
  const single = (type: string) =>
    info.rateLimitType === type ? toWindow(info.utilization, info.resetsAt) : null;
  const fiveHour = toWindow(windows.five_hour?.utilization, windows.five_hour?.resetsAt) ?? single("five_hour");
  const sevenDay = toWindow(windows.seven_day?.utilization, windows.seven_day?.resetsAt) ?? single("seven_day");
  usage = {
    fiveHour: fiveHour ?? usage.fiveHour,
    sevenDay: sevenDay ?? usage.sevenDay,
    limited: info.status === "rejected",
    updatedAt: Date.now(),
  };
  if (auth.signedIn !== true) auth.signedIn = true; // A report means the run was signed in.
  saveUsage();
  changed();
}

export async function refreshPlan() {
  const status = await readAuthStatus();
  auth = status
    ? { signedIn: status.loggedIn, plan: status.loggedIn ? (status.subscriptionType ?? null) : null }
    : { signedIn: null, plan: null };
  changed();
}

export function startPlanWatch() {
  loadUsage();
  onRateLimit(record);
  refreshPlan().catch(() => {});
  setInterval(() => refreshPlan().catch(() => {}), AUTH_RECHECK_MS).unref();
}

/** A window whose reset time has passed is unknown until the next report. */
const current = (window: UsageWindow | null) => (window && window.resetsAt > Date.now() ? window : null);

export function planView(): PlanView {
  return {
    cli: Boolean(findClaudeCli()),
    signedIn: auth.signedIn,
    plan: auth.plan,
    fiveHour: current(usage.fiveHour),
    sevenDay: current(usage.sevenDay),
    limited: usage.limited && Boolean(current(usage.fiveHour) || current(usage.sevenDay)),
    updatedAt: usage.updatedAt,
    checking,
  };
}

/**
 * Reads the latest usage now with the smallest possible Claude Code run: Haiku, a one-line system
 * prompt and no tools. It still counts, a little, towards the plan's limits.
 */
export async function checkUsageNow() {
  if (checking) return;
  checking = true;
  changed();
  try {
    const result = await runClaudeCli({
      cwd: CHECK_DIR,
      prompt: "Reply with just: ok",
      args: [
        "--model", "claude-haiku-4-5",
        "--system-prompt", "Reply with just: ok",
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
      ],
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    if (result.is_error) throw new ClaudeCliError(resultError(result));
  } finally {
    checking = false;
    await refreshPlan().catch(() => {});
  }
}

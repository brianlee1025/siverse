import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Installs Claude Code hooks that report what Claude Code is doing to Siverse. Each hook is a
// background (`async`) curl that posts the hook's JSON to the local Siverse server and always
// succeeds, so Claude Code is never slowed down or bothered when Siverse isn't running.

const EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "Stop",
] as const;

export const HOOK_PATH = "/api/claude-code/hook";

interface HookHandler {
  type: string;
  command?: string;
  async?: boolean;
}
interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

/** User-level settings by default; `.claude/settings.local.json` inside a project if given. */
export function settingsFile(projectDir?: string) {
  return projectDir
    ? path.join(path.resolve(projectDir), ".claude", "settings.local.json")
    : path.join(os.homedir(), ".claude", "settings.json");
}

function hookCommand(port: number) {
  return `curl -s -m 2 -o /dev/null -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}${HOOK_PATH} || true`;
}

const isSiverseHandler = (h: HookHandler) => typeof h.command === "string" && h.command.includes(HOOK_PATH);

function read(file: string): Settings {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {}; // No settings file yet.
  }
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${file} isn't valid JSON, so Siverse won't touch it. Fix it and try again.`);
  }
}

function write(file: string, settings: Settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.siverse-backup`);
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Removes Siverse's handlers, dropping groups and events that end up empty. */
function withoutSiverse(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isSiverseHandler(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const next: Settings = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

export function isInstalled(projectDir?: string): boolean {
  try {
    const { hooks } = read(settingsFile(projectDir));
    return Object.values(hooks ?? {}).some((groups) => groups.some((g) => (g.hooks ?? []).some(isSiverseHandler)));
  } catch {
    return false;
  }
}

export function install(port: number, projectDir?: string): string {
  const file = settingsFile(projectDir);
  const settings = withoutSiverse(read(file));
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command: hookCommand(port), async: true }] }];
  }
  write(file, { ...settings, hooks });
  return file;
}

export function uninstall(projectDir?: string): string {
  const file = settingsFile(projectDir);
  if (fs.existsSync(file) && isInstalled(projectDir)) write(file, withoutSiverse(read(file)));
  return file;
}

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";
import type { ApprovedCommand, AskFirst, CommandRun, CommandView, Department, Task } from "../shared/types";
import { shorten } from "./claude";
import { hideFromClaudeCode } from "./claudeCli";
import { DATA_DIR, DRIVE_DIR, ROOT_DIR } from "./config";
import { resolveInside } from "./drive";
import { OfficeError } from "./office";
import { addChat, changed, newId, state } from "./store";

// Approved commands: the only way a worker can run anything. Workers never get a shell. The boss
// approves a script from a department's folder on the drive, and Siverse keeps a copy of it in
// data/tools, where workers can't write. When a worker asks to run it (the run_command tool),
// Siverse runs that copy itself:
// - without a shell, as `<program> <approved copy> <args>`, in the script's folder on the drive
// - with a minimal environment plus only the variables the boss named (e.g. a password), which
//   Siverse reads from its own environment or .env. Claude Code runs never get them, and their
//   values are blanked out of anything the worker sees
// - after the boss's OK on the task, unless the boss said this command doesn't need one.

const TOOLS_DIR = path.join(DATA_DIR, "tools");
const ENV_FILE = path.join(ROOT_DIR, ".env");
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;
export const RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT = 20_000;
const ACTIVITY_LINES = 8;
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PROGRAM = /^[A-Za-z0-9_.:\\/ -]{1,200}$/;
// What any program needs to start; everything else in Siverse's environment stays out.
const BASE_ENV = [
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP", "HOME",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "LANG", "LC_ALL", "TZ",
];

// ---- configuration (boss only) ---------------------------------------------------------------

export interface CommandInput {
  name: string;
  description: string;
  program: string;
  script: string; // path inside the department's folder, e.g. "emails/send_email.py"
  askFirst: AskFirst;
  secrets: string[];
}

const toolDir = (command: ApprovedCommand) => path.join(TOOLS_DIR, command.id);
const approvedCopy = (command: ApprovedCommand) => path.join(toolDir(command), path.basename(command.script));
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function departmentScript(department: Department, script: string): { file: string; drivePath: string } {
  const root = path.join(DRIVE_DIR, department.id);
  const relative = script.trim().replace(/\\/g, "/").replace(new RegExp(`^${department.id}/`), "");
  const file = resolveInside(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new OfficeError(`There's no file "${relative}" in ${department.name}'s folder.`);
  }
  return { file, drivePath: path.relative(DRIVE_DIR, file).split(path.sep).join("/") };
}

function clean(input: Partial<CommandInput>, department: Department, except?: ApprovedCommand) {
  const out: Partial<ApprovedCommand> = {};
  if (input.name !== undefined) {
    const name = input.name.trim().toLowerCase().replace(/\s+/g, "_");
    if (!NAME.test(name)) throw new OfficeError("Name it with lowercase letters, digits, _ or -, e.g. send_email.");
    if (state.commands.some((c) => c !== except && c.departmentId === department.id && c.name === name)) {
      throw new OfficeError(`${department.name} already has a command called ${name}.`);
    }
    out.name = name;
  }
  if (input.description !== undefined) out.description = input.description.trim().slice(0, 1000);
  if (input.program !== undefined) {
    const program = input.program.trim();
    if (!PROGRAM.test(program)) throw new OfficeError("The program is a single name or path, e.g. python, py or node.");
    out.program = program;
  }
  if (input.askFirst !== undefined) {
    if (!["always", "with-args", "never"].includes(input.askFirst)) throw new OfficeError("Pick when to ask first.");
    out.askFirst = input.askFirst;
  }
  if (input.secrets !== undefined) {
    const secrets = [...new Set(input.secrets.map((s) => s.trim()).filter(Boolean))];
    const bad = secrets.find((s) => !ENV_NAME.test(s));
    if (bad) throw new OfficeError(`"${bad}" isn't an environment variable name.`);
    out.secrets = secrets.slice(0, 20);
  }
  return out;
}

/** Copies the script as it is now into data/tools: that copy is what runs. */
function approveScript(command: ApprovedCommand, department: Department, script: string) {
  const { file, drivePath } = departmentScript(department, script);
  fs.rmSync(toolDir(command), { recursive: true, force: true });
  fs.mkdirSync(toolDir(command), { recursive: true });
  command.script = drivePath;
  fs.copyFileSync(file, approvedCopy(command));
  command.scriptHash = sha256(approvedCopy(command));
  command.approvedAt = Date.now();
}

export function addCommand(department: Department, input: CommandInput): ApprovedCommand {
  const fields = clean(input, department);
  if (!fields.name || !fields.program) throw new OfficeError("A command needs a name and a program.");
  const command: ApprovedCommand = {
    id: newId("cmd"),
    departmentId: department.id,
    name: fields.name,
    description: fields.description ?? "",
    program: fields.program,
    script: "",
    scriptHash: "",
    approvedAt: 0,
    askFirst: fields.askFirst ?? "always",
    secrets: fields.secrets ?? [],
  };
  approveScript(command, department, input.script);
  state.commands.push(command);
  changed();
  return command;
}

export function updateCommand(command: ApprovedCommand, patch: Partial<CommandInput>) {
  const department = requireDepartment(command);
  Object.assign(command, clean(patch, department, command));
  if (patch.script !== undefined) approveScript(command, department, patch.script);
  changed();
}

/** Approves the script as it is on the drive now, after the boss has checked the changes. */
export function reapproveCommand(command: ApprovedCommand) {
  approveScript(command, requireDepartment(command), command.script.split("/").slice(1).join("/"));
  changed();
}

export function removeCommand(command: ApprovedCommand) {
  state.commands = state.commands.filter((c) => c !== command);
  fs.rmSync(toolDir(command), { recursive: true, force: true });
  changed();
}

export function deleteDepartmentCommands(departmentId: string) {
  for (const command of state.commands.filter((c) => c.departmentId === departmentId)) removeCommand(command);
}

export function findCommand(id: string) {
  return state.commands.find((c) => c.id === id);
}

function requireDepartment(command: ApprovedCommand): Department {
  const department = state.departments.find((d) => d.id === command.departmentId);
  if (!department) throw new OfficeError("That command's department was closed.");
  return department;
}

// ---- secrets ---------------------------------------------------------------------------------

let envCache: { stamp: string; values: Record<string, string> } | null = null;

/**
 * .env is checked again on every call, so a new password works without restarting Siverse. It is
 * only re-parsed when its mtime or size changed: the snapshot asks for it many times a second.
 */
function envFile(): Record<string, string> {
  let stamp = "missing";
  try {
    const stat = fs.statSync(ENV_FILE);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // No .env: cache the empty result under "missing".
  }
  if (envCache?.stamp === stamp) return envCache.values;
  let values: Record<string, string> = {};
  if (stamp !== "missing") {
    try {
      values = parseEnv(fs.readFileSync(ENV_FILE, "utf8")) as Record<string, string>;
    } catch {
      values = {};
    }
  }
  envCache = { stamp, values };
  return values;
}

function secretValues(command: ApprovedCommand): Record<string, string> {
  const fromFile = envFile();
  const values: Record<string, string> = {};
  for (const name of command.secrets) {
    const value = fromFile[name] ?? process.env[name];
    if (value) values[name] = value;
  }
  return values;
}

// Claude Code runs (manager and workers) never get any command's secrets in their environment.
hideFromClaudeCode(() => state.commands.flatMap((c) => c.secrets));

// ---- view ------------------------------------------------------------------------------------

const changedCache = new Map<string, { stamp: string; changed: boolean }>();

/** Whether the script on the drive is still the approved version. Hashes only when the file changed. */
function scriptChanged(command: ApprovedCommand): boolean {
  try {
    const file = resolveInside(DRIVE_DIR, command.script);
    const stat = fs.statSync(file);
    const stamp = `${command.scriptHash}:${stat.mtimeMs}:${stat.size}`;
    const cached = changedCache.get(command.id);
    if (cached?.stamp === stamp) return cached.changed;
    const result = sha256(file) !== command.scriptHash;
    changedCache.set(command.id, { stamp, changed: result });
    return result;
  } catch {
    return true; // Moved or deleted.
  }
}

export function commandViews(): CommandView[] {
  const fromFile = envFile();
  return state.commands.map((c) => ({
    ...c,
    scriptChanged: scriptChanged(c),
    missingSecrets: c.secrets.filter((name) => !(fromFile[name] ?? process.env[name])),
  }));
}

/** How the command looks to a person: "py send_email.py --send". */
export function commandLine(command: ApprovedCommand, args: string[]) {
  const quote = (a: string) => (/[\s"']/.test(a) || a === "" ? JSON.stringify(a) : a);
  return [command.program, path.basename(command.script), ...args].map(quote).join(" ");
}

/** The approved commands section of a worker's instructions, or "" when there are none. */
export function commandsBrief(department: Department): string {
  const commands = state.commands.filter((c) => c.departmentId === department.id);
  if (!commands.length) return "";
  const lines = commands.map((c) => {
    const ask =
      c.askFirst === "always"
        ? "Every run needs the boss's OK."
        : c.askFirst === "with-args"
          ? "Running it with no arguments needs no OK; with any arguments it needs the boss's OK."
          : "It runs without asking.";
    const folder = path.posix.dirname(c.script);
    return `- ${c.name}: ${c.description || "(no description)"}\n  Runs \`${c.program} ${path.basename(c.script)} [your arguments]\` in ${folder}/ on the drive. ${ask}`;
  });
  return `Approved commands. You have no shell; these are the only things you can run, with the run_command tool (name, args as a list of strings, and a one-line reason for the boss):
${lines.join("\n")}
They get any credentials they need themselves; you never see them. When a run needs the boss's OK, the tool waits until they answer (up to 30 minutes). If they say no, don't try to get around it: note it in your summary.`;
}

// ---- running ---------------------------------------------------------------------------------

const runningCommands = new Set<string>();
const pending = new Map<string, (approved: boolean) => void>(); // task id → answer

function needsOk(command: ApprovedCommand, args: string[]) {
  return command.askFirst === "always" || (command.askFirst === "with-args" && args.length > 0);
}

function record(task: Task, run: CommandRun) {
  task.commandRuns = [...(task.commandRuns ?? []), run].slice(-30);
  changed();
}

function pushActivity(task: Task, line: string) {
  task.activity.push(shorten(line));
  if (task.activity.length > ACTIVITY_LINES) task.activity.splice(0, task.activity.length - ACTIVITY_LINES);
  changed();
}

/** Blanks out every secret value, in case a script prints one. */
function scrub(text: string, secrets: string[]) {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("•••");
  return out;
}

function askBoss(task: Task, command: ApprovedCommand, args: string[], reason: string, signal?: AbortSignal) {
  if (pending.has(task.id)) throw new OfficeError("This task is already waiting for the boss's answer.");
  const department = state.departments.find((d) => d.id === task.departmentId);
  task.approval = { commandId: command.id, commandLine: commandLine(command, args), reason, requestedAt: Date.now() };
  pushActivity(task, `✋ Waiting for your OK to run ${command.name}`);
  addChat(
    "system",
    `✋ ${task.workerName ?? "A worker"} in ${department?.name ?? "the office"} wants to run: ${task.approval.commandLine}. Open "${task.title}" to answer.`,
    { tone: "info" },
  );
  return new Promise<boolean | "no-answer">((resolve) => {
    const done = (answer: boolean | "no-answer") => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(task.id);
      delete task.approval;
      changed();
      resolve(answer);
    };
    const timer = setTimeout(() => done("no-answer"), APPROVAL_TIMEOUT_MS);
    const onAbort = () => done(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(task.id, done);
  });
}

/** The boss's answer from the task card. */
export function answerApproval(task: Task, approve: boolean) {
  const answer = pending.get(task.id);
  if (!answer) throw new OfficeError("Nothing on this task is waiting for an answer.");
  answer(approve);
}

/** When a task's run ends, nobody can answer for it any more, and its commands stop. */
export function endCommandSession(taskId: string) {
  pending.get(taskId)?.(false);
  sessions.get(taskId)?.stop.abort();
  sessions.delete(taskId);
}

/**
 * Runs an approved command for a worker and returns what the worker sees: the outcome and the
 * (scrubbed) output. Never throws for a refusal or a failed run; the worker reads why.
 */
export async function runApprovedCommand(
  task: Task,
  name: string,
  args: unknown,
  reason: string,
  signal?: AbortSignal,
): Promise<string> {
  const command = state.commands.find((c) => c.departmentId === task.departmentId && c.name === String(name).trim());
  if (!command) {
    const names = state.commands.filter((c) => c.departmentId === task.departmentId).map((c) => c.name);
    return `There's no approved command "${name}". Approved: ${names.join(", ") || "none"}.`;
  }
  if (!Array.isArray(args) || args.length > 30 || args.some((a) => typeof a !== "string" || a.length > 500 || a.includes("\0"))) {
    return "args must be a list of up to 30 strings.";
  }
  const argv = args as string[];
  const run: CommandRun = { name: command.name, args: argv, askedBoss: false, outcome: "error", at: Date.now() };

  if (!fs.existsSync(approvedCopy(command)) || sha256(approvedCopy(command)) !== command.scriptHash) {
    record(task, run);
    return "The approved copy of this script is missing or was changed, so it won't run. Ask the boss to approve it again.";
  }
  if (runningCommands.has(command.id)) {
    record(task, run);
    return `${command.name} is already running for another task. Try again later.`;
  }
  const secrets = secretValues(command);
  const missing = command.secrets.filter((n) => !secrets[n]);
  if (missing.length) {
    record(task, run);
    return `It can't run yet: the boss hasn't set ${missing.join(", ")}. Tell them in your summary.`;
  }

  if (needsOk(command, argv)) {
    run.askedBoss = true;
    const answer = await askBoss(task, command, argv, shorten(reason || "(no reason given)", 300), signal);
    if (answer !== true) {
      run.outcome = answer === "no-answer" ? "no-answer" : "denied";
      record(task, run);
      return answer === "no-answer"
        ? "The boss didn't answer within 30 minutes, so it didn't run."
        : "The boss said no, so it didn't run.";
    }
  }

  runningCommands.add(command.id);
  pushActivity(task, `▶ Running ${command.name}`);
  try {
    const result = await spawnCommand(command, argv, secrets, signal, (line) =>
      pushActivity(task, `▶ ${command.name}: ${scrub(line, Object.values(secrets))}`),
    );
    run.exitCode = result.code;
    run.outcome = result.code === 0 ? "ok" : "failed";
    record(task, run);
    const output = scrub(result.output, Object.values(secrets)).trim() || "(no output)";
    return `${result.timedOut ? `Stopped after ${RUN_TIMEOUT_MS / 60_000} minutes. ` : ""}Exit code ${result.code ?? "none"}.\n${output}`;
  } catch (error) {
    record(task, run);
    return `Couldn't start ${command.program}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    runningCommands.delete(command.id);
  }
}

const trimOutput = (text: string) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, 2000)}\n[…]\n${text.slice(-(MAX_OUTPUT - 2000))}` : text;

function spawnCommand(
  command: ApprovedCommand,
  args: string[],
  secrets: Record<string, string>,
  signal: AbortSignal | undefined,
  onLine: (line: string) => void,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
  for (const [key, value] of Object.entries(process.env)) {
    if (BASE_ENV.includes(key.toUpperCase())) env[key] = value;
  }
  Object.assign(env, secrets);
  const cwd = path.dirname(resolveInside(DRIVE_DIR, command.script));

  return new Promise((resolve, reject) => {
    const child = spawn(command.program, [approvedCopy(command), ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let partial = "";
    let timedOut = false;
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = trimOutput(output + text);
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const stop = () => child.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, RUN_TIMEOUT_MS);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ code, output, timedOut });
    });
  });
}

// ---- Claude Code workers ---------------------------------------------------------------------
// A Claude Code worker reaches run_command through a small MCP server (scripts/siverse-worker-mcp.mjs)
// that calls this server. Each run gets a random token, so a request can only act for that task.

const sessions = new Map<string, { token: string; stop: AbortController }>(); // by task id
const jobs = new Map<string, { taskId: string; state: "waiting" | "running" | "done"; result?: string; at: number }>();

export function commandSession(taskId: string): string {
  let session = sessions.get(taskId);
  if (!session) {
    session = { token: randomBytes(24).toString("hex"), stop: new AbortController() };
    sessions.set(taskId, session);
  }
  return session.token;
}

function sessionTask(taskId: string, token: string) {
  const session = sessions.get(taskId);
  const task = state.tasks.find((t) => t.id === taskId);
  if (!session || session.token !== token || !task || task.status !== "working") throw new OfficeError("Not a running task.");
  return { task, signal: session.stop.signal };
}

/** Starts a run for a Claude Code worker; the MCP server polls jobStatus until it is done. */
export function startJob(taskId: string, token: string, name: string, args: unknown, reason: string): string {
  const { task, signal } = sessionTask(taskId, token);
  const id = newId("job");
  const job = { taskId, state: "running" as "waiting" | "running" | "done", result: undefined as string | undefined, at: Date.now() };
  jobs.set(id, job);
  runApprovedCommand(task, name, args, reason, signal)
    .then((result) => Object.assign(job, { state: "done", result }))
    .catch((error) => Object.assign(job, { state: "done", result: error instanceof Error ? error.message : String(error) }));
  // Old finished jobs are never asked for again.
  for (const [key, old] of jobs) if (old.state === "done" && Date.now() - old.at > 3 * 3_600_000) jobs.delete(key);
  return id;
}

export function jobStatus(taskId: string, token: string, id: string) {
  const job = jobs.get(id);
  if (!job || job.taskId !== taskId || sessions.get(taskId)?.token !== token) throw new OfficeError("No such job.");
  const task = state.tasks.find((t) => t.id === taskId);
  if (job.state !== "done") return { state: task?.approval ? "waiting_for_boss" : "running" };
  jobs.delete(id);
  return { state: "done", result: job.result };
}

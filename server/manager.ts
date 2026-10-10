import fs from "node:fs";
import path from "node:path";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages";
import { z } from "zod";
import type { Department, Employee, ScheduleCadence } from "../shared/types";
import { MAX_HEADCOUNT, isClaudeCode } from "../shared/types";
import { forgetClaudeCodeManager, handleBossMessageClaudeCode } from "./ccManager";
import { blockActivity, explainError, finalText, modelParams, shorten } from "./claude";
import { COMPANY_MEMORY_DIR, DATA_DIR, MANAGER_MAX_ITERATIONS, MAX_CONCURRENT_WORKERS } from "./config";
import { listDrive, readDriveFile } from "./drive";
import { describeStaff, fireEmployee, hireEmployee, updateEmployee } from "./employees";
import { createMemoryTool } from "./memory";
import {
  OfficeError,
  assignTask,
  cancelTask,
  closeDepartment,
  createDepartment,
  followUpTask,
  updateDepartment,
} from "./office";
import {
  createSchedule,
  deleteSchedule,
  describeSchedules,
  findSchedule,
  runScheduleNow,
  updateSchedule,
  whenNext,
} from "./schedules";
import { getClient, getSettings } from "./settings";
import { addChat, changed, findDepartment, findEmployee, findTask, managerStatus, state } from "./store";

// The manager is the boss's chat partner: one long-running Claude conversation that turns
// instructions into departments and tasks. Its history is append-only and saved to disk, and it
// keeps lasting notes about the boss in its memory directory, which survives a "new day" reset.

const HISTORY_FILE = path.join(DATA_DIR, "manager-history.json");
let history: BetaMessageParam[] = [];

export function loadManagerHistory() {
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    history = [];
  }
}

function saveHistory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

export function startNewDay() {
  if (managerStatus.busy) throw new OfficeError("The manager is still busy. Try again in a moment.");
  history = [];
  saveHistory();
  forgetClaudeCodeManager();
  addChat("system", "☀️ A new workday begins. The manager starts fresh but keeps their notes.", { tone: "info" });
}

export function systemPrompt(companyName: string) {
  return `You are the office manager of ${companyName}, a company in Siverse, a 3D office simulator. The person chatting with you is the boss. The work is real: you turn the boss's instructions into an organisation that gets it done.

How the office works:
- Departments are teams that each focus on one genre of work (for example Marketing for copywriting and social posts, Engineering for code, Research for investigation and reports). Each has standing instructions and a headcount, which is how many of its tasks can be worked on at once.
- Every task goes to exactly one department. A worker picks it up, does the work, and saves deliverables to the company drive (one folder per department). Workers can't ask questions mid-task, so write self-contained briefs: the goal, audience, format, length, and anything the boss said that matters.
- Up to ${MAX_CONCURRENT_WORKERS} workers can be at their desks across the whole office; extra tasks wait in a queue.
- Departments can have permanent employees. Each keeps one desk, has their own area within the department's work (their focus), and keeps their own notes, so they get better at their area over time. Give work in someone's area to them by name (the employee field of assign_task and create_schedule); they do one task at a time and the rest wait for them. Work without a name goes to a temp at a free desk, or to a free employee. Hire someone when the boss asks, or suggest it when a department keeps getting work in one area. Firing someone keeps their notes; only the boss can delete them.
- A finished task can be followed up: the same worker carries on with it, with the conversation so far and the files they already made. When the boss wants more, changes or fixes to finished work, use follow_up_task on that task instead of assigning a new one.
- Schedules are recurring tasks a department runs on a timetable (daily, weekly, or every few hours, in local time). Each run sees the earlier runs' work and the department's notes, so a schedule is how the boss gets standing jobs like a weekly report.

How to act:
- Do what the boss asks with your tools instead of describing what you would do.
- Create a department when the boss asks for one, or when a request clearly needs one that doesn't exist yet, and say that you did.
- Send work to the best-fitting department. Split big requests into a few standalone tasks, across departments if needed.
- When the boss asks about results, read the task result or the files and report back briefly.
- Each boss message starts with an <office_status> block with the live state of the office. Trust it over earlier turns.
- Keep notes on the boss's lasting preferences and important company decisions in your memory directory. Never store secrets.
- Reply like a sharp, friendly chief of staff: a few short sentences, plain text, no headings. Say which department got which task.`;
}

export function officeStatus(): string {
  const lines = [`Company: ${getSettings().companyName}`];
  // Claude Code projects are only mirrored in the office; the manager doesn't run them.
  const departments = state.departments.filter((d) => !isClaudeCode(d));
  if (!departments.length) {
    lines.push("Departments: none yet.");
  } else {
    lines.push("Departments:");
    for (const d of departments) {
      const tasks = state.tasks.filter((t) => t.departmentId === d.id);
      const working = tasks.filter((t) => t.status === "working").length;
      const queued = tasks.filter((t) => t.status === "queued").length;
      lines.push(
        `- ${d.name} [id: ${d.id}]: ${d.genre}. Headcount ${d.headcount}, web access ${d.webAccess ? "yes" : "no"}. Working ${working}, queued ${queued}.`,
      );
      if (d.description) lines.push(`  Standing instructions: ${shorten(d.description, 240)}`);
      const commands = state.commands.filter((c) => c.departmentId === d.id).map((c) => c.name);
      if (commands.length) lines.push(`  Approved commands its workers can run: ${commands.join(", ")}. Only the boss can change these.`);
      const staff = describeStaff(d.id);
      lines.push(staff.length ? "  Permanent employees:" : "  Permanent employees: none (temps only).", ...staff);
    }
  }
  const recent = state.tasks.filter((t) => !isClaudeCode(t)).slice(-15);
  if (recent.length) {
    lines.push("Recent tasks (oldest first):");
    for (const t of recent) {
      const department = state.departments.find((d) => d.id === t.departmentId)?.name ?? "closed department";
      const detail = t.summary ? ` → ${shorten(t.summary, 160)}` : t.error ? ` → ${shorten(t.error, 120)}` : "";
      lines.push(`- ${t.id} | ${department}${t.workerName ? ` | ${t.workerName}` : ""} | ${t.status} | "${t.title}"${detail}`);
    }
  }
  const schedules = describeSchedules();
  lines.push(schedules.length ? "Schedules:" : "Schedules: none yet.", ...schedules);
  lines.push(`Local time now: ${new Date().toLocaleString()}`);
  return lines.join("\n");
}

function requireDepartment(ref: string): Department {
  const department = findDepartment(ref);
  if (!department) {
    const names = state.departments.filter((d) => !isClaudeCode(d)).map((d) => d.name).join(", ") || "none";
    throw new OfficeError(`No department "${ref}". Existing departments: ${names}.`);
  }
  return department;
}

function requireEmployee(ref: string): Employee {
  const employee = findEmployee(ref);
  if (!employee) {
    const names = state.employees.map((e) => e.name).join(", ") || "none";
    throw new OfficeError(`No employee "${ref}". Permanent employees: ${names}.`);
  }
  return employee;
}

/** An optional employee name or id inside a department, as the manager's tools take it. */
function employeeIn(department: Department, ref: string | undefined): string | undefined {
  if (!ref?.trim()) return undefined;
  const employee = findEmployee(ref, department.id);
  if (!employee) throw new OfficeError(`Nobody called "${ref}" works in ${department.name}.`);
  return employee.id;
}

function describeTool(name: string, input: unknown): string | null {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "hire_employee":
      return `Hiring for ${args.department ?? "a department"}`;
    case "update_employee":
      return `Briefing ${args.employee ?? "an employee"}`;
    case "fire_employee":
      return `Letting ${args.employee ?? "someone"} go`;
    case "create_department":
      return `Setting up the ${args.name ?? "new"} department`;
    case "update_department":
      return `Reorganising ${args.department ?? "a department"}`;
    case "close_department":
      return `Closing ${args.department ?? "a department"}`;
    case "assign_task":
      return `Handing "${args.title ?? "a task"}" to ${args.department ?? "a department"}`;
    case "cancel_task":
      return "Cancelling a task";
    case "follow_up_task":
      return "Following up on a task";
    case "get_task_result":
    case "read_file":
    case "list_files":
      return "Reviewing the work";
    case "memory":
      return "Checking notes";
    default:
      return null;
  }
}

function managerTools() {
  return [
    betaZodTool({
      name: "create_department",
      description:
        "Open a new department that specialises in one genre of work. It starts without web access; only the boss can turn that on, in the department's window.",
      inputSchema: z.object({
        name: z.string().describe('Short team name, e.g. "Marketing"'),
        genre: z.string().describe('The kind of work it takes on, e.g. "copywriting, social posts and campaigns"'),
        instructions: z.string().describe("Standing instructions every worker in this department follows"),
        headcount: z.number().int().min(1).max(MAX_HEADCOUNT).optional().describe("Desks = tasks at once. Default 2."),
      }),
      run: (args) => {
        const d = createDepartment({
          name: args.name,
          genre: args.genre,
          description: args.instructions,
          headcount: args.headcount,
        });
        return `Created ${d.name} [id: ${d.id}] with ${d.headcount} desk(s).`;
      },
    }),
    betaZodTool({
      name: "update_department",
      description: "Change a department's name, genre, standing instructions or headcount, or turn its web access off.",
      inputSchema: z.object({
        department: z.string().describe("Department id or name"),
        name: z.string().optional(),
        genre: z.string().optional(),
        instructions: z.string().optional(),
        headcount: z.number().int().min(1).max(MAX_HEADCOUNT).optional(),
        web_access: z.boolean().optional().describe("false turns web access off. Only the boss can turn it on."),
      }),
      run: (args) => {
        const d = requireDepartment(args.department);
        // Like code access, web access is only turned on by the boss (it lets workers send data out).
        updateDepartment(d, {
          name: args.name,
          genre: args.genre,
          description: args.instructions,
          headcount: args.headcount,
          webAccess: args.web_access === false ? false : undefined,
        });
        const webNote =
          args.web_access && !d.webAccess
            ? " Web access is still off: only the boss can turn it on, in the department's window. Ask them if it's needed."
            : "";
        return `Updated ${d.name}.${webNote}`;
      },
    }),
    betaZodTool({
      name: "close_department",
      description: "Close a department that has no open tasks. Its files stay on the drive.",
      inputSchema: z.object({ department: z.string().describe("Department id or name") }),
      run: ({ department }) => {
        const d = requireDepartment(department);
        closeDepartment(d);
        return `Closed ${d.name}.`;
      },
    }),
    betaZodTool({
      name: "assign_task",
      description: "Give a department a task. A worker starts as soon as a desk is free.",
      inputSchema: z.object({
        department: z.string().describe("Department id or name"),
        title: z.string().describe("Short task title, under 80 characters"),
        brief: z.string().describe("Self-contained brief: goal, audience, format, length, constraints"),
        employee: z.string().optional().describe("A permanent employee's name, for work in their area. Omit for whoever is free."),
      }),
      run: ({ department, title, brief, employee }) => {
        const d = requireDepartment(department);
        const task = assignTask(d, title, brief, { employeeId: employeeIn(d, employee) });
        return `Assigned ${task.id} to ${d.name} (${task.status === "working" ? "a worker started on it" : "queued"}).`;
      },
    }),
    betaZodTool({
      name: "cancel_task",
      description: "Cancel a queued or in-progress task.",
      inputSchema: z.object({ task_id: z.string() }),
      run: ({ task_id }) => {
        const task = findTask(task_id);
        if (!task) throw new OfficeError(`No task ${task_id}.`);
        cancelTask(task);
        return `Cancelling ${task_id}.`;
      },
    }),
    betaZodTool({
      name: "follow_up_task",
      description:
        "Send a finished (or failed) task back to the same worker with a follow-up: more work, changes or fixes. They carry on with the conversation so far and the files they already made.",
      inputSchema: z.object({
        task_id: z.string(),
        message: z.string().describe("What they should do next, as a self-contained instruction"),
      }),
      run: ({ task_id, message }) => {
        const task = findTask(task_id);
        if (!task) throw new OfficeError(`No task ${task_id}.`);
        followUpTask(task, message);
        return `Sent ${task_id} back to ${task.workerName ?? "the department"} (${task.status === "working" ? "they started on it" : "queued"}).`;
      },
    }),
    betaZodTool({
      name: "get_task_result",
      description: "Get a task's status, the worker's summary, its output files and any error.",
      inputSchema: z.object({ task_id: z.string() }),
      run: ({ task_id }) => {
        const t = findTask(task_id);
        if (!t) throw new OfficeError(`No task ${task_id}.`);
        return JSON.stringify({
          id: t.id,
          title: t.title,
          status: t.status,
          worker: t.workerName,
          summary: t.summary,
          outputs: t.outputs,
          error: t.error,
          conversation: t.thread?.slice(-6).map((m) => ({ from: m.role, text: m.text.slice(0, 1500) })),
          recent_activity: t.activity.slice(-4),
        });
      },
    }),
    betaZodTool({
      name: "list_files",
      description: "List files on the company drive, optionally inside one department folder.",
      inputSchema: z.object({ folder: z.string().optional() }),
      run: ({ folder }) => listDrive(folder ?? "").join("\n") || "(no files yet)",
    }),
    betaZodTool({
      name: "read_file",
      description: "Read a file from the company drive.",
      inputSchema: z.object({ path: z.string().describe('Drive path, e.g. "marketing/launch-post.md"') }),
      run: ({ path }) => readDriveFile(path),
    }),
    betaZodTool({
      name: "create_schedule",
      description:
        "Give a department a recurring task that runs on a timetable, e.g. every Monday at 09:00. Each run builds on the last one's work and the department's notes.",
      inputSchema: z.object({
        department: z.string().describe("Department id or name"),
        title: z.string().describe("Short title, under 80 characters"),
        brief: z.string().describe("Self-contained brief for every run"),
        cadence: cadenceSchema,
        employee: z.string().optional().describe("A permanent employee who always does it. Omit for whoever is free."),
      }),
      run: ({ department, title, brief, cadence, employee }) => {
        const d = requireDepartment(department);
        const employeeId = employeeIn(d, employee);
        const schedule = createSchedule(d, { title, brief, cadence: cadence as ScheduleCadence, employeeId });
        return `Created schedule ${schedule.id}: ${whenNext(schedule)}.`;
      },
    }),
    betaZodTool({
      name: "update_schedule",
      description:
        'Change a schedule\'s title, brief, timetable or employee, or pause (enabled: false) and resume it. employee: "" gives it to whoever is free.',
      inputSchema: z.object({
        schedule_id: z.string(),
        title: z.string().optional(),
        brief: z.string().optional(),
        cadence: cadenceSchema.optional(),
        enabled: z.boolean().optional(),
        employee: z.string().optional(),
      }),
      run: ({ schedule_id, title, brief, cadence, enabled, employee }) => {
        const schedule = requireSchedule(schedule_id);
        const department = requireDepartment(schedule.departmentId);
        const employeeId = employee === undefined ? undefined : (employeeIn(department, employee) ?? null);
        updateSchedule(schedule, { title, brief, cadence: cadence as ScheduleCadence | undefined, enabled, employeeId });
        return schedule.enabled ? `Updated: ${whenNext(schedule)}.` : "Paused.";
      },
    }),
    betaZodTool({
      name: "delete_schedule",
      description: "Remove a schedule. Tasks it already started are not affected.",
      inputSchema: z.object({ schedule_id: z.string() }),
      run: ({ schedule_id }) => {
        deleteSchedule(requireSchedule(schedule_id));
        return `Removed ${schedule_id}.`;
      },
    }),
    betaZodTool({
      name: "run_schedule_now",
      description: "Start a schedule's task right away, without changing its timetable.",
      inputSchema: z.object({ schedule_id: z.string() }),
      run: ({ schedule_id }) => `Started ${runScheduleNow(requireSchedule(schedule_id)).id}.`,
    }),
    betaZodTool({
      name: "hire_employee",
      description:
        "Hire a permanent employee into a department. They take a desk of their own (one is added if needed), focus on one area of the department's work, and keep their own notes.",
      inputSchema: z.object({
        department: z.string().describe("Department id or name"),
        focus: z.string().describe('Their area, e.g. "competitor pricing in Europe" or "the onboarding emails"'),
        name: z.string().optional().describe("First name. Omit to pick one."),
      }),
      run: ({ department, focus, name }) => {
        const d = requireDepartment(department);
        const e = hireEmployee(d, { name, focus });
        return `Hired ${e.name} [id: ${e.id}] in ${d.name}, at desk ${e.deskIndex + 1}.`;
      },
    }),
    betaZodTool({
      name: "update_employee",
      description: "Change a permanent employee's area of focus or name.",
      inputSchema: z.object({
        employee: z.string().describe("Employee name or id"),
        focus: z.string().optional(),
        name: z.string().optional(),
      }),
      run: ({ employee, focus, name }) => {
        const e = requireEmployee(employee);
        updateEmployee(e, { focus, name });
        return `Updated ${e.name}.`;
      },
    }),
    betaZodTool({
      name: "fire_employee",
      description:
        "Let a permanent employee go. Their desk stays for temps, work waiting for them goes to whoever is free, and their notes are kept.",
      inputSchema: z.object({ employee: z.string().describe("Employee name or id") }),
      run: ({ employee }) => {
        const e = requireEmployee(employee);
        fireEmployee(e);
        return `${e.name} has left. Their notes are kept.`;
      },
    }),
    createMemoryTool(COMPANY_MEMORY_DIR),
  ];
}

const cadenceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("daily"), time: z.string().describe("24-hour HH:MM") }),
    z.object({
      kind: z.literal("weekly"),
      day: z.number().int().min(0).max(6).describe("0 = Sunday … 6 = Saturday"),
      time: z.string().describe("24-hour HH:MM"),
    }),
    z.object({ kind: z.literal("interval"), hours: z.number().int().min(1).describe("Hours between runs") }),
    z
      .object({ kind: z.literal("after"), scheduleId: z.string().describe("Id of the schedule to follow (sched_…)") })
      .describe("Run right after another schedule's task finishes successfully"),
  ])
  .describe("When it runs, in local time, or after another schedule");

function requireSchedule(id: string) {
  const schedule = findSchedule(id);
  if (!schedule) throw new OfficeError(`No schedule ${id}.`);
  return schedule;
}

/** If the last turn stopped with tool calls that never got results, answer them before moving on. */
function danglingToolResults(): BetaToolResultBlockParam[] {
  const last = history.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return [];
  return last.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      type: "tool_result" as const,
      tool_use_id: (b as { id: string }).id,
      content: "Interrupted before this ran.",
      is_error: true,
    }));
}

export async function handleBossMessage(text: string) {
  if (managerStatus.busy) throw new OfficeError("The manager is still replying. Wait a moment.");
  addChat("boss", text);

  if (getSettings().engine === "claude-code") {
    return handleBossMessageClaudeCode(text, officeStatus(), systemPrompt(getSettings().companyName));
  }

  const client = getClient();
  if (!client) {
    addChat("system", "Add your Claude API key in Settings to bring the office to life.", { tone: "error" });
    return;
  }

  const { managerModel, companyName } = getSettings();
  const reply = addChat("manager", "", { streaming: true });
  managerStatus.busy = true;
  managerStatus.activity = "Reading your message";
  changed();

  const userMessage: BetaMessageParam = {
    role: "user",
    content: [
      ...danglingToolResults(),
      { type: "text", text: `<office_status>\n${officeStatus()}\n</office_status>\n\n${text}` },
    ],
  };

  try {
    const runner = client.beta.messages.toolRunner({
      ...modelParams(managerModel, "medium"),
      max_tokens: 32000,
      stream: true,
      max_iterations: MANAGER_MAX_ITERATIONS,
      cache_control: { type: "ephemeral" },
      system: systemPrompt(companyName),
      tools: managerTools(),
      messages: [...history, userMessage],
    });

    let last: BetaMessage | undefined;
    for await (const stream of runner) {
      let startedText = false;
      stream.on("text", (delta) => {
        if (!startedText && reply.text) reply.text += "\n\n";
        startedText = true;
        reply.text += delta;
        changed();
      });
      stream.on("contentBlock", (block) => {
        const line = blockActivity(block, describeTool);
        if (line) {
          managerStatus.activity = shorten(line, 90);
          changed();
        }
      });
      last = await stream.finalMessage();
      if (last.stop_reason === "refusal" || last.stop_reason === "max_tokens") break;
    }

    if (last?.stop_reason === "refusal") {
      // Leave the declined turn out of the history so the conversation can carry on.
      reply.text = "Sorry boss, I can't help with that one.";
    } else {
      history = runner.params.messages;
      reply.text = reply.text.trim() || finalText(last) || "Done.";
    }
  } catch (error) {
    reply.text = explainError(error);
    reply.tone = "error";
  } finally {
    reply.streaming = false;
    managerStatus.busy = false;
    managerStatus.activity = null;
    saveHistory();
    changed();
  }
}

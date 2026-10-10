#!/usr/bin/env node
// Siverse's office tools as an MCP server, for the manager on the "claude-code" engine.
// Claude Code starts this over stdio; every tool is a call to the Siverse server's local API
// (SIVERSE_URL, 127.0.0.1 only), so the manager can only do what the boss could do in the UI.
// Plain JavaScript with no dependencies, so it runs with the same `node` as Siverse.

import readline from "node:readline";

const BASE = (process.env.SIVERSE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

const cadence = {
  type: "object",
  description:
    'When it runs, in local time. {"kind":"daily","time":"09:00"}, {"kind":"weekly","day":1,"time":"09:00"} (day 0 = Sunday ... 6 = Saturday) or {"kind":"interval","hours":6}.',
  properties: {
    kind: { type: "string", enum: ["daily", "weekly", "interval"] },
    time: { type: "string", description: "24-hour HH:MM, for daily and weekly" },
    day: { type: "integer", minimum: 0, maximum: 6, description: "Weekday, for weekly" },
    hours: { type: "integer", minimum: 1, description: "Hours between runs, for interval" },
  },
  required: ["kind"],
};

const TOOLS = [
  {
    name: "office_status",
    description:
      "The live state of the office: departments, their permanent employees, headcount and load, recent tasks and schedules.",
    inputSchema: { type: "object", properties: {} },
    call: () => get("/api/office/status").then((r) => r.status),
  },
  {
    name: "create_department",
    description: "Open a new department that specialises in one genre of work.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Short team name, e.g. "Marketing"' },
        genre: { type: "string", description: 'The kind of work it takes on, e.g. "copywriting, social posts and campaigns"' },
        instructions: { type: "string", description: "Standing instructions every worker in this department follows" },
        headcount: { type: "integer", minimum: 1, maximum: 6, description: "Desks = tasks at once. Default 2." },
        web_access: { type: "boolean", description: "Whether its workers may search and read the web. Default false." },
      },
      required: ["name", "genre", "instructions"],
    },
    call: (a) =>
      send("POST", "/api/departments", {
        name: a.name,
        genre: a.genre ?? "",
        description: a.instructions ?? "",
        headcount: a.headcount,
        webAccess: a.web_access,
      }).then((d) => `Created ${d.name} [id: ${d.id}] with ${d.headcount} desk(s).`),
  },
  {
    name: "update_department",
    description: "Change a department's name, genre, standing instructions, headcount or web access.",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string", description: "Department id or name" },
        name: { type: "string" },
        genre: { type: "string" },
        instructions: { type: "string" },
        headcount: { type: "integer", minimum: 1, maximum: 6 },
        web_access: { type: "boolean" },
      },
      required: ["department"],
    },
    call: (a) =>
      send("PATCH", `/api/departments/${encodeURIComponent(a.department)}`, {
        name: a.name,
        genre: a.genre,
        description: a.instructions,
        headcount: a.headcount,
        webAccess: a.web_access,
      }).then((d) => `Updated ${d.name}.`),
  },
  {
    name: "close_department",
    description: "Close a department that has no open tasks. Its files stay on the drive; its schedules are removed.",
    inputSchema: { type: "object", properties: { department: { type: "string" } }, required: ["department"] },
    call: (a) => send("DELETE", `/api/departments/${encodeURIComponent(a.department)}`).then(() => `Closed ${a.department}.`),
  },
  {
    name: "assign_task",
    description: "Give a department a task. A worker starts as soon as a desk is free.",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string", description: "Department id or name" },
        title: { type: "string", description: "Short task title, under 80 characters" },
        brief: { type: "string", description: "Self-contained brief: goal, audience, format, length, constraints" },
        employee: {
          type: "string",
          description: "A permanent employee's name, for work in their area. Omit for whoever is free.",
        },
      },
      required: ["department", "title", "brief"],
    },
    call: (a) =>
      send("POST", `/api/departments/${encodeURIComponent(a.department)}/tasks`, {
        title: a.title,
        brief: a.brief,
        employee: a.employee,
      }).then(
        (t) => `Assigned ${t.id} (${t.status === "working" ? "a worker started on it" : "queued"}).`,
      ),
  },
  {
    name: "cancel_task",
    description: "Cancel a queued or in-progress task.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
    call: (a) => send("POST", `/api/tasks/${encodeURIComponent(a.task_id)}/cancel`).then(() => `Cancelling ${a.task_id}.`),
  },
  {
    name: "follow_up_task",
    description:
      "Send a finished (or failed) task back to the same worker with a follow-up: more work, changes or fixes. They carry on with the conversation so far and the files they already made.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        message: { type: "string", description: "What they should do next, as a self-contained instruction" },
      },
      required: ["task_id", "message"],
    },
    call: (a) =>
      send("POST", `/api/tasks/${encodeURIComponent(a.task_id)}/follow-up`, { text: a.message }).then(
        (t) => `Sent ${t.id} back to ${t.workerName ?? "the department"} (${t.status === "working" ? "they started on it" : "queued"}).`,
      ),
  },
  {
    name: "get_task_result",
    description: "Get a task's status, the worker's summary, its output files and any error.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
    call: (a) => get(`/api/tasks/${encodeURIComponent(a.task_id)}`).then((t) => JSON.stringify(t)),
  },
  {
    name: "list_files",
    description: "List files on the company drive, optionally inside one department folder.",
    inputSchema: { type: "object", properties: { folder: { type: "string" } } },
    call: (a) =>
      get(`/api/files?folder=${encodeURIComponent(a.folder ?? "")}`).then((r) => r.files.join("\n") || "(no files yet)"),
  },
  {
    name: "read_file",
    description: "Read a file from the company drive.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: 'Drive path, e.g. "marketing/launch-post.md"' } },
      required: ["path"],
    },
    call: (a) => get(`/api/file?path=${encodeURIComponent(a.path)}`).then((r) => r.content),
  },
  {
    name: "create_schedule",
    description:
      "Give a department a recurring task that runs on a timetable, e.g. every Monday at 09:00. Each run builds on the last one's work and the department's notes.",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string", description: "Department id or name" },
        title: { type: "string", description: "Short title, under 80 characters" },
        brief: { type: "string", description: "Self-contained brief for every run" },
        cadence,
        employee: { type: "string", description: "A permanent employee who always does it. Omit for whoever is free." },
      },
      required: ["department", "title", "brief", "cadence"],
    },
    call: (a) =>
      send("POST", `/api/departments/${encodeURIComponent(a.department)}/schedules`, {
        title: a.title,
        brief: a.brief,
        cadence: a.cadence,
        employee: a.employee,
      }).then((s) => `Created schedule ${s.id}. First run ${new Date(s.nextRunAt).toLocaleString()}.`),
  },
  {
    name: "update_schedule",
    description:
      'Change a schedule\'s title, brief, timetable or employee, or pause (enabled: false) and resume it. employee: "" gives it to whoever is free.',
    inputSchema: {
      type: "object",
      properties: {
        schedule_id: { type: "string" },
        title: { type: "string" },
        brief: { type: "string" },
        cadence,
        enabled: { type: "boolean" },
        employee: { type: "string" },
      },
      required: ["schedule_id"],
    },
    call: (a) =>
      send("PATCH", `/api/schedules/${encodeURIComponent(a.schedule_id)}`, {
        title: a.title,
        brief: a.brief,
        cadence: a.cadence,
        enabled: a.enabled,
        employee: a.employee,
      }).then((s) => `Updated ${s.id}. ${s.enabled ? `Next run ${new Date(s.nextRunAt).toLocaleString()}.` : "Paused."}`),
  },
  {
    name: "delete_schedule",
    description: "Remove a schedule. Tasks it already started are not affected.",
    inputSchema: { type: "object", properties: { schedule_id: { type: "string" } }, required: ["schedule_id"] },
    call: (a) => send("DELETE", `/api/schedules/${encodeURIComponent(a.schedule_id)}`).then(() => `Removed ${a.schedule_id}.`),
  },
  {
    name: "run_schedule_now",
    description: "Start a schedule's task right away, without changing its timetable.",
    inputSchema: { type: "object", properties: { schedule_id: { type: "string" } }, required: ["schedule_id"] },
    call: (a) =>
      send("POST", `/api/schedules/${encodeURIComponent(a.schedule_id)}/run`).then((t) => `Started ${t.id}.`),
  },
  {
    name: "hire_employee",
    description:
      "Hire a permanent employee into a department. They take a desk of their own (one is added if needed), focus on one area of the department's work, and keep their own notes.",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string", description: "Department id or name" },
        focus: { type: "string", description: 'Their area, e.g. "competitor pricing in Europe" or "the onboarding emails"' },
        name: { type: "string", description: "First name. Omit to pick one." },
      },
      required: ["department", "focus"],
    },
    call: (a) =>
      send("POST", `/api/departments/${encodeURIComponent(a.department)}/employees`, { focus: a.focus, name: a.name }).then(
        (e) => `Hired ${e.name} [id: ${e.id}], at desk ${e.deskIndex + 1}.`,
      ),
  },
  {
    name: "update_employee",
    description: "Change a permanent employee's area of focus or name.",
    inputSchema: {
      type: "object",
      properties: {
        employee: { type: "string", description: "Employee name or id" },
        focus: { type: "string" },
        name: { type: "string" },
      },
      required: ["employee"],
    },
    call: (a) =>
      send("PATCH", `/api/employees/${encodeURIComponent(a.employee)}`, { focus: a.focus, name: a.name }).then(
        (e) => `Updated ${e.name}.`,
      ),
  },
  {
    name: "fire_employee",
    description:
      "Let a permanent employee go. Their desk stays for temps, work waiting for them goes to whoever is free, and their notes are kept.",
    inputSchema: {
      type: "object",
      properties: { employee: { type: "string", description: "Employee name or id" } },
      required: ["employee"],
    },
    // Never deleteNotes: only the boss can delete an employee's notes, from the UI.
    call: (a) =>
      send("DELETE", `/api/employees/${encodeURIComponent(a.employee)}`).then((r) => `${r.name} has left. Their notes are kept.`),
  },
];

async function get(path) {
  return request("GET", path);
}

async function send(method, path, body) {
  // Leave out fields the manager didn't set, so a PATCH only changes what was asked.
  const clean = body && Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  return request(method, path, clean);
}

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) throw new Error(data.error || `Siverse answered ${response.status}.`);
  return data;
}

// ---- MCP over stdio: one JSON-RPC message per line ------------------------------------------

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // A notification: nothing to answer.
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "siverse", version: "0.1.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return reply(id, { content: [{ type: "text", text: `No tool ${params?.name}.` }], isError: true });
      try {
        const text = await tool.call(params?.arguments ?? {});
        return reply(id, { content: [{ type: "text", text: String(text) }] });
      } catch (error) {
        return reply(id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return fail(null, -32700, "Parse error");
  }
  handle(message).catch((error) => fail(message.id ?? null, -32603, String(error)));
});

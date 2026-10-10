#!/usr/bin/env node
// The run_command tool as an MCP server, for workers on the "claude-code" engine whose department
// has approved commands. Claude Code starts this over stdio for one task. It only asks the Siverse
// server (SIVERSE_URL, 127.0.0.1) to run an approved command for that task (SIVERSE_TASK, with
// that run's SIVERSE_TOKEN): Siverse decides whether it may run, asks the boss when needed, runs
// it and returns the output. Plain JavaScript with no dependencies, so it runs with Siverse's node.

import readline from "node:readline";

const BASE = (process.env.SIVERSE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const TASK = process.env.SIVERSE_TASK || "";
const TOKEN = process.env.SIVERSE_TOKEN || "";
const POLL_MS = 2000;

const TOOLS = [
  {
    name: "run_command",
    description:
      "Run one of your department's approved commands (they are listed in your instructions). Some runs wait for the boss's OK first; this tool waits for their answer and then returns the command's output.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The approved command's name, e.g. send_email" },
        args: { type: "array", items: { type: "string" }, description: 'Arguments, one per item, e.g. ["--limit", "20"]. Empty for none.' },
        reason: { type: "string", description: "One line for the boss: what this run does and why now" },
      },
      required: ["name", "args", "reason"],
    },
    call: async (a) => {
      const { job } = await post("/api/worker/commands", { name: a.name, args: a.args ?? [], reason: a.reason ?? "" });
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const status = await post(`/api/worker/jobs/${encodeURIComponent(job)}`, {});
        if (status.state === "done") return status.result;
      }
    },
  },
];

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, task: TASK, token: TOKEN }),
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
        serverInfo: { name: "siverse-worker", version: "0.1.0" },
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

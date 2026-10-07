import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { ServerMessage } from "../shared/types";
import { MAX_HEADCOUNT } from "../shared/types";
import { forgetClaudeCli } from "./claudeCli";
import { handleHookEvent, sweepClaudeCode } from "./claudeCode";
import { HOOK_PATH, install as installHooks, uninstall as uninstallHooks } from "./claudeCodeHooks";
import { DIST_DIR, HOST, IS_PRODUCTION, PORT } from "./config";
import { DriveError, listDrive, readDriveFile } from "./drive";
import { handleBossMessage, loadManagerHistory, officeStatus, startNewDay } from "./manager";
import {
  OfficeError,
  assignTask,
  cancelTask,
  closeDepartment,
  createDepartment,
  retryTask,
  schedule,
  updateDepartment,
} from "./office";
import {
  createSchedule,
  deleteSchedule,
  findSchedule,
  notesTidyUp,
  runScheduleNow,
  startScheduleClock,
  updateSchedule,
} from "./schedules";
import { isLocalRequest, localOnly } from "./security";
import { aiOfficeEnabled, loadSettings, updateSettings } from "./settings";
import { changed, findDepartment, findTask, forgetHooksCheck, loadState, onChange, saveNow, snapshot } from "./store";

loadSettings();
loadState();
loadManagerHistory();

const app = express();
app.disable("x-powered-by");
app.use(localOnly);

// Claude Code hook events. Tool inputs can carry whole files (e.g. Write), hence the larger limit;
// only short descriptions are kept. Always answer 200 with no decisions so Claude Code carries on.
app.post(HOOK_PATH, express.json({ limit: "25mb" }), (req, res) => {
  try {
    if (req.body && typeof req.body === "object") handleHookEvent(req.body);
  } catch (error) {
    console.error("[claude-code]", error);
  }
  res.json({});
});

app.use(express.json({ limit: "1mb" }));

const ChatBody = z.object({ text: z.string().trim().min(1).max(8000) });
const SettingsBody = z.object({
  companyName: z.string().max(60).optional(),
  aiOffice: z.boolean().optional(),
  engine: z.enum(["api", "claude-code"]).optional(),
  apiKey: z.string().max(400).optional(),
  managerModel: z.string().max(80).optional(),
  workerModel: z.string().max(80).optional(),
});
const DepartmentBody = z.object({
  name: z.string().min(1).max(40),
  genre: z.string().max(120).default(""),
  description: z.string().max(2000).default(""),
  headcount: z.number().int().min(1).max(MAX_HEADCOUNT).optional(),
  webAccess: z.boolean().optional(),
});
const TaskBody = z.object({
  title: z.string().min(1).max(120),
  brief: z.string().min(1).max(8000),
});
const Cadence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time: z.string().max(5) }),
  z.object({ kind: z.literal("weekly"), day: z.number().int().min(0).max(6), time: z.string().max(5) }),
  z.object({ kind: z.literal("interval"), hours: z.number().int().min(1).max(24 * 28) }),
]);
const ScheduleBody = z.object({
  title: z.string().min(1).max(120),
  brief: z.string().min(1).max(8000),
  cadence: Cadence,
  enabled: z.boolean().optional(),
});

const param = (req: Request, name: string) => String(req.params[name]);

/** Routes that run Siverse's own (API-billed) agents only work while the AI office is on. */
function requireAiOffice(_req: Request, res: Response, next: NextFunction) {
  if (aiOfficeEnabled()) return next();
  res.status(409).json({ error: "The AI office is turned off. Turn it on in Settings to use it." });
}

app.get("/api/state", (_req, res) => {
  res.json(snapshot());
});

app.post("/api/chat", requireAiOffice, (req, res) => {
  const { text } = ChatBody.parse(req.body);
  // The reply streams over the WebSocket; the request returns as soon as the message is accepted.
  handleBossMessage(text).catch((error) => console.error("[manager]", error));
  res.status(202).json({ ok: true });
});

app.post("/api/new-day", requireAiOffice, (_req, res) => {
  startNewDay();
  res.json({ ok: true });
});

app.get("/api/office/status", requireAiOffice, (_req, res) => {
  res.json({ status: officeStatus() });
});

app.put("/api/settings", (req, res) => {
  updateSettings(SettingsBody.parse(req.body));
  forgetClaudeCli(); // look for the Claude Code CLI again, e.g. after installing it
  changed(); // push the new settings to every open browser
  schedule(); // A newly added key can start queued work.
  res.json(snapshot().settings);
});

app.post("/api/claude-code/connect", (_req, res) => {
  let file: string;
  try {
    file = installHooks(PORT);
  } catch (error) {
    return void res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
  forgetHooksCheck();
  changed();
  res.json({ ok: true, file });
});

app.post("/api/claude-code/disconnect", (_req, res) => {
  const file = uninstallHooks();
  forgetHooksCheck();
  changed();
  res.json({ ok: true, file });
});

app.post("/api/departments", requireAiOffice, (req, res) => {
  res.status(201).json(createDepartment(DepartmentBody.parse(req.body)));
});

app.patch("/api/departments/:id", requireAiOffice, (req, res) => {
  const department = findDepartment(param(req, "id"));
  if (!department) return void res.status(404).json({ error: "No such department." });
  updateDepartment(department, DepartmentBody.partial().parse(req.body));
  res.json(department);
});

app.delete("/api/departments/:id", requireAiOffice, (req, res) => {
  const department = findDepartment(param(req, "id"));
  if (!department) return void res.status(404).json({ error: "No such department." });
  closeDepartment(department);
  res.json({ ok: true });
});

app.post("/api/departments/:id/tasks", requireAiOffice, (req, res) => {
  const department = findDepartment(param(req, "id"));
  if (!department) return void res.status(404).json({ error: "No such department." });
  const { title, brief } = TaskBody.parse(req.body);
  res.status(201).json(assignTask(department, title, brief));
});

app.post("/api/departments/:id/schedules", requireAiOffice, (req, res) => {
  const department = findDepartment(param(req, "id"));
  if (!department) return void res.status(404).json({ error: "No such department." });
  res.status(201).json(createSchedule(department, ScheduleBody.parse(req.body)));
});

app.post("/api/departments/:id/schedules/notes-tidy-up", requireAiOffice, (req, res) => {
  const department = findDepartment(param(req, "id"));
  if (!department) return void res.status(404).json({ error: "No such department." });
  res.status(201).json(createSchedule(department, notesTidyUp(department)));
});

app.patch("/api/schedules/:id", requireAiOffice, (req, res) => {
  const schedule = findSchedule(param(req, "id"));
  if (!schedule) return void res.status(404).json({ error: "No such schedule." });
  updateSchedule(schedule, ScheduleBody.partial().parse(req.body));
  res.json(schedule);
});

app.delete("/api/schedules/:id", requireAiOffice, (req, res) => {
  const schedule = findSchedule(param(req, "id"));
  if (!schedule) return void res.status(404).json({ error: "No such schedule." });
  deleteSchedule(schedule);
  res.json({ ok: true });
});

app.post("/api/schedules/:id/run", requireAiOffice, (req, res) => {
  const schedule = findSchedule(param(req, "id"));
  if (!schedule) return void res.status(404).json({ error: "No such schedule." });
  res.status(201).json(runScheduleNow(schedule));
});

app.get("/api/tasks/:id", (req, res) => {
  const task = findTask(param(req, "id"));
  if (!task) return void res.status(404).json({ error: "No such task." });
  const { id, title, status, workerName, summary, outputs, error, activity, scheduleId } = task;
  res.json({ id, title, status, worker: workerName, summary, outputs, error, scheduleId, recent_activity: activity.slice(-4) });
});

app.post("/api/tasks/:id/cancel", (req, res) => {
  const task = findTask(param(req, "id"));
  if (!task) return void res.status(404).json({ error: "No such task." });
  cancelTask(task);
  res.json({ ok: true });
});

app.post("/api/tasks/:id/retry", requireAiOffice, (req, res) => {
  const task = findTask(param(req, "id"));
  if (!task) return void res.status(404).json({ error: "No such task." });
  res.status(201).json(retryTask(task));
});

app.get("/api/files", (req, res) => {
  const folder = typeof req.query.folder === "string" ? req.query.folder : "";
  res.json({ files: listDrive(folder) });
});

app.get("/api/file", (req, res) => {
  const filePath = typeof req.query.path === "string" ? req.query.path : "";
  res.json({ path: filePath, content: readDriveFile(filePath) });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

if (IS_PRODUCTION && fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    return void res.status(400).json({ error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }
  if (error instanceof OfficeError) return void res.status(409).json({ error: error.message });
  if (error instanceof DriveError) return void res.status(400).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sockets = new Set<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "", "http://localhost").pathname !== "/ws" || !isLocalRequest(req)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    send(ws);
  });
});

function send(ws: WebSocket) {
  const message: ServerMessage = { type: "snapshot", data: snapshot() };
  ws.send(JSON.stringify(message));
}

onChange(() => {
  for (const ws of sockets) if (ws.readyState === ws.OPEN) send(ws);
});

setInterval(sweepClaudeCode, 60_000).unref();

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.error(`\n  ❌ Port ${PORT} is already in use. Is Siverse already running in another terminal?`);
  console.error("     Stop it, or start this one on another port, e.g. PORT=8788 npm run dev\n");
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = IS_PRODUCTION ? `http://localhost:${PORT}` : "http://localhost:5173";
  console.log(`\n  🏢 Siverse server on http://${HOST}:${PORT}  →  open ${url}\n`);
  schedule();
  startScheduleClock();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    try {
      saveNow();
    } catch (error) {
      console.error("Couldn't save the office state on shutdown:", error);
    }
    process.exit(0);
  });
}

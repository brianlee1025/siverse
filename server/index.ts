import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { ServerMessage } from "../shared/types";
import { MAX_HEADCOUNT } from "../shared/types";
import { DIST_DIR, HOST, IS_PRODUCTION, PORT } from "./config";
import { DriveError, listDrive, readDriveFile } from "./drive";
import { handleBossMessage, loadManagerHistory, startNewDay } from "./manager";
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
import { isLocalRequest, localOnly } from "./security";
import { loadSettings, updateSettings } from "./settings";
import { findDepartment, findTask, loadState, onChange, saveNow, snapshot } from "./store";

loadSettings();
loadState();
loadManagerHistory();

const app = express();
app.disable("x-powered-by");
app.use(localOnly);
app.use(express.json({ limit: "1mb" }));

const ChatBody = z.object({ text: z.string().trim().min(1).max(8000) });
const SettingsBody = z.object({
  companyName: z.string().max(60).optional(),
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

const param = (req: Request, name: string) => String(req.params[name]);

app.get("/api/state", (_req, res) => {
  res.json(snapshot());
});

app.post("/api/chat", (req, res) => {
  const { text } = ChatBody.parse(req.body);
  // The reply streams over the WebSocket; the request returns as soon as the message is accepted.
  handleBossMessage(text).catch((error) => console.error("[manager]", error));
  res.status(202).json({ ok: true });
});

app.post("/api/new-day", (_req, res) => {
  startNewDay();
  res.json({ ok: true });
});

app.put("/api/settings", (req, res) => {
  updateSettings(SettingsBody.parse(req.body));
  schedule(); // A newly added key can start queued work.
  res.json(snapshot().settings);
});

app.post("/api/departments", (req, res) => {
  res.status(201).json(createDepartment(DepartmentBody.parse(req.body)));
});

app.patch("/api/departments/:id", (req, res) => {
  const department = findDepartment(param(req, "id"));
  if (!department) return void res.status(404).json({ error: "No such department." });
  updateDepartment(department, DepartmentBody.partial().parse(req.body));
  res.json(department);
});

app.delete("/api/departments/:id", (req, res) => {
  const department = findDepartment(param(req, "id"));
  if (!department) return void res.status(404).json({ error: "No such department." });
  closeDepartment(department);
  res.json({ ok: true });
});

app.post("/api/departments/:id/tasks", (req, res) => {
  const department = findDepartment(param(req, "id"));
  if (!department) return void res.status(404).json({ error: "No such department." });
  const { title, brief } = TaskBody.parse(req.body);
  res.status(201).json(assignTask(department, title, brief));
});

app.post("/api/tasks/:id/cancel", (req, res) => {
  const task = findTask(param(req, "id"));
  if (!task) return void res.status(404).json({ error: "No such task." });
  cancelTask(task);
  res.json({ ok: true });
});

app.post("/api/tasks/:id/retry", (req, res) => {
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

server.listen(PORT, HOST, () => {
  const url = IS_PRODUCTION ? `http://localhost:${PORT}` : "http://localhost:5173";
  console.log(`\n  🏢 Siverse server on http://${HOST}:${PORT}  →  open ${url}\n`);
  schedule();
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

import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile();
} catch {
  // No .env file - everything has a default or can be set in the Settings screen.
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const DIST_DIR = path.join(ROOT_DIR, "dist");

// The "company drive": every file a worker produces lands here, one folder per department.
export const DRIVE_DIR = path.join(ROOT_DIR, "workspace");

// Memory tool roots. The manager remembers things about the boss and the company;
// each department keeps its own notebook so e.g. Marketing remembers the brand voice.
export const COMPANY_MEMORY_DIR = path.join(DATA_DIR, "memory", "company");
export const departmentMemoryDir = (departmentId: string) =>
  path.join(DATA_DIR, "memory", "departments", departmentId);

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? "127.0.0.1";
export const IS_PRODUCTION = process.env.NODE_ENV === "production";

export const MAX_CONCURRENT_WORKERS = Math.max(1, Number(process.env.MAX_CONCURRENT_WORKERS ?? 4));

export const DEFAULT_MODEL = "claude-opus-5-5";

// Agent loop limits: one "iteration" is one API request. Workers do real multi-step work,
// so they get more room; the manager mostly routes and should answer quickly.
export const MANAGER_MAX_ITERATIONS = 12;
export const WORKER_MAX_ITERATIONS = 30;

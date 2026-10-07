import fs from "node:fs";
import path from "node:path";
import { DRIVE_DIR } from "./config";

// The company drive is a plain folder on disk (./workspace). Every path that comes from the
// model is untrusted, so it is resolved against a root and rejected if it escapes it.

const MAX_READ_BYTES = 200_000;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 300;

export class DriveError extends Error {}

export function resolveInside(root: string, untrusted: string): string {
  const cleaned = untrusted.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(root, cleaned);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DriveError(`Path "${untrusted}" is outside the allowed folder.`);
  }
  return target;
}

/** Writes a text file into a department's folder and returns its drive path. */
export function writeDepartmentFile(departmentId: string, relativePath: string, content: string): string {
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
    throw new DriveError("File is too large (limit 1 MB). Split it into several files.");
  }
  const departmentRoot = path.join(DRIVE_DIR, departmentId);
  const target = resolveInside(departmentRoot, relativePath);
  if (target === departmentRoot) throw new DriveError("Give the file a name.");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return path.relative(DRIVE_DIR, target).split(path.sep).join("/");
}

export function readDriveFile(drivePath: string): string {
  const target = resolveInside(DRIVE_DIR, drivePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new DriveError(`No file at "${drivePath}".`);
  }
  if (!stat.isFile()) throw new DriveError(`"${drivePath}" is a folder, not a file.`);
  const fd = fs.openSync(target, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8");
    return stat.size > MAX_READ_BYTES ? `${text}\n\n[... truncated, file is ${stat.size} bytes]` : text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Lists files under a drive folder, recursively, as drive paths. */
export function listDrive(folder = ""): string[] {
  const start = resolveInside(DRIVE_DIR, folder);
  const results: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= MAX_LIST_ENTRIES || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) results.push(path.relative(DRIVE_DIR, full).split(path.sep).join("/"));
    }
  };
  walk(start);
  return results;
}

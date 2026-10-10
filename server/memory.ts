import fs from "node:fs";
import path from "node:path";
import { betaMemoryTool, type MemoryToolHandlers } from "@anthropic-ai/sdk/helpers/beta/memory";
import { DriveError, resolveInside } from "./drive";

// File-backed implementation of Claude's memory tool. Claude always addresses files as
// /memories/..., which we map onto real folders: one for the manager (company memory), one per
// department, and for a permanent employee both their department's notes and their own, as
// /memories/team/ and /memories/me/.

const MAX_FILE_BYTES = 100_000;

/** One folder for all of /memories, or named folders: { team: dir } is /memories/team/. */
export type MemoryRoots = string | Record<string, string>;

interface Resolved {
  file: string; // on disk; empty for the /memories listing of named folders
  base: string; // the folder that holds it
  prefix: string; // the base's memory path, e.g. "/memories/team"
}

function toDisk(roots: MemoryRoots, memoryPath: string): Resolved {
  const normalized = memoryPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized !== "/memories" && !normalized.startsWith("/memories/")) {
    throw new DriveError(`Memory paths must start with /memories (got "${memoryPath}").`);
  }
  const rest = normalized.slice("/memories".length);
  if (typeof roots === "string") return { file: resolveInside(roots, rest), base: roots, prefix: "/memories" };
  const [name, ...inside] = rest.split("/").filter(Boolean);
  if (!name) return { file: "", base: "", prefix: "/memories" };
  const base = roots[name];
  if (!base) {
    const names = Object.keys(roots).map((n) => `/memories/${n}/`).join(" or ");
    throw new DriveError(`Memory paths go inside ${names} (got "${memoryPath}").`);
  }
  return { file: resolveInside(base, inside.join("/")), base, prefix: `/memories/${name}` };
}

/** A path to a file, never one of the memory folders themselves. */
function fileAt(roots: MemoryRoots, memoryPath: string): string {
  const { file, base } = toDisk(roots, memoryPath);
  if (!file || file === base) throw new DriveError(`${memoryPath} is a folder. Give a file path inside it.`);
  return file;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    throw new DriveError("That memory file does not exist.");
  }
}

function writeText(file: string, text: string) {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new DriveError("Memory files are limited to 100 KB.");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function listTree(base: string, prefix: string, dir: string, depth: number, lines: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const display = `${prefix}/${path.relative(base, full).split(path.sep).join("/")}`;
    if (entry.isDirectory()) {
      lines.push(`-\t${display}/`);
      if (depth < 2) listTree(base, prefix, full, depth + 1, lines);
    } else {
      lines.push(`${fs.statSync(full).size}\t${display}`);
    }
  }
}

export function createMemoryTool(roots: MemoryRoots) {
  for (const dir of typeof roots === "string" ? [roots] : Object.values(roots)) fs.mkdirSync(dir, { recursive: true });

  const handlers: MemoryToolHandlers = {
    view({ path: memoryPath, view_range }) {
      const { file: target, base, prefix } = toDisk(roots, memoryPath);
      if (!target && typeof roots !== "string") {
        const lines: string[] = [];
        for (const [name, dir] of Object.entries(roots)) {
          lines.push(`-\t/memories/${name}/`);
          listTree(dir, `/memories/${name}`, dir, 2, lines);
        }
        return `Files and folders in /memories (size in bytes):\n${lines.join("\n")}`;
      }
      if (!fs.existsSync(target)) throw new DriveError(`Nothing at ${memoryPath}.`);
      if (fs.statSync(target).isDirectory()) {
        const lines: string[] = [];
        listTree(base, prefix, target, 1, lines);
        return lines.length
          ? `Files and folders in ${memoryPath} (size in bytes):\n${lines.join("\n")}`
          : `${memoryPath} is empty.`;
      }
      const all = readText(target).split("\n");
      const [start, end] = view_range ?? [1, all.length];
      const from = Math.max(1, start);
      const to = end === -1 ? all.length : Math.min(all.length, end);
      return all
        .slice(from - 1, to)
        .map((line, i) => `${String(from + i).padStart(6)}\t${line}`)
        .join("\n");
    },
    create({ path: memoryPath, file_text }) {
      writeText(fileAt(roots, memoryPath), file_text);
      return `File created successfully at ${memoryPath}`;
    },
    str_replace({ path: memoryPath, old_str, new_str }) {
      const target = fileAt(roots, memoryPath);
      const text = readText(target);
      const count = text.split(old_str).length - 1;
      if (count === 0) throw new DriveError(`old_str was not found in ${memoryPath}.`);
      if (count > 1) throw new DriveError(`old_str appears ${count} times in ${memoryPath}; make it unique.`);
      writeText(target, text.replace(old_str, () => new_str));
      return `The memory file ${memoryPath} has been edited.`;
    },
    insert({ path: memoryPath, insert_line, insert_text }) {
      const target = fileAt(roots, memoryPath);
      const lines = readText(target).split("\n");
      if (insert_line < 0 || insert_line > lines.length) {
        throw new DriveError(`insert_line must be between 0 and ${lines.length}.`);
      }
      lines.splice(insert_line, 0, ...insert_text.split("\n"));
      writeText(target, lines.join("\n"));
      return `Text inserted at line ${insert_line} of ${memoryPath}.`;
    },
    delete({ path: memoryPath }) {
      const { file: target, base } = toDisk(roots, memoryPath);
      if (!target || target === base) throw new DriveError("Refusing to delete a whole memory directory.");
      if (!fs.existsSync(target)) throw new DriveError(`Nothing at ${memoryPath}.`);
      fs.rmSync(target, { recursive: true });
      return `Deleted ${memoryPath}`;
    },
    rename({ old_path, new_path }) {
      const from = fileAt(roots, old_path);
      const to = fileAt(roots, new_path);
      if (!fs.existsSync(from)) throw new DriveError(`Nothing at ${old_path}.`);
      if (fs.existsSync(to)) throw new DriveError(`${new_path} already exists.`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return `Renamed ${old_path} to ${new_path}`;
    },
  };

  return betaMemoryTool(handlers);
}

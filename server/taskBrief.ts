import type { Task } from "../shared/types";

// What a worker is told about its task. A follow-up runs the same task again, so the worker also
// gets the conversation so far and the files already made for it, and carries on from there.

const MAX_HISTORY_CHARS = 16_000;

export function taskBrief(task: Task): string {
  const brief = `Task ${task.id}: ${task.title}\n\nBrief from the manager:\n${task.brief}`;
  if (!task.thread?.length) return brief;

  // Newest messages matter most: drop the oldest ones if the conversation gets long.
  const lines: string[] = [];
  let length = 0;
  for (const message of [...task.thread].reverse()) {
    const line = `${message.role === "boss" ? "The boss" : "You"}: ${message.text.trim()}`;
    if (lines.length && length + line.length > MAX_HISTORY_CHARS) {
      lines.push("(earlier messages left out)");
      break;
    }
    lines.push(line);
    length += line.length;
  }
  const files = task.outputs.length
    ? `\n\nFiles already saved for this task (company drive paths):\n${task.outputs.map((p) => `- ${p}`).join("\n")}`
    : "";

  return `${brief}

This task was already worked on, and the boss has followed up. The conversation so far, oldest first:

${lines.reverse().join("\n\n")}${files}

Carry on with this task: do what the boss's latest message asks, building on what is already there. Read the files above and update them rather than starting over, unless the boss asks for something new. When you're done, reply to the boss's latest message with a short summary of what you changed and where.`;
}

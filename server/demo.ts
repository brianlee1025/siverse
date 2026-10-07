import type { Department, Task } from "../shared/types";
import { writeDepartmentFile } from "./drive";
import { changed } from "./store";

// Demo mode (SIVERSE_DEMO=1): workers act out a task without calling the Claude API, so you can
// work on the office scene and UI without an API key or spending anything.

export const DEMO_MODE = process.env.SIVERSE_DEMO === "1";

const STEPS = [
  "🧠 Checking the department notes",
  "Reading the brief and sketching an outline",
  "📝 Writing a first draft",
  "Tightening the wording and checking the details",
  "🧠 Updating the department notes",
];

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Cancelled."));
    });
  });

export async function runDemoWorker(task: Task, department: Department, signal: AbortSignal): Promise<string> {
  for (const step of STEPS) {
    await sleep(3000 + Math.random() * 3000, signal);
    task.activity.push(step);
    changed();
  }
  const file = writeDepartmentFile(
    department.id,
    `demo/${task.id}.md`,
    `# ${task.title}\n\n_Demo mode: no API call was made._\n\n## Brief\n\n${task.brief}\n`,
  );
  task.outputs.push(file);
  changed();
  return `Demo run: saved a placeholder to ${file}.`;
}

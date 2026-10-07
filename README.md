# 🏢 Siverse

**A 3D office simulator where you are the boss and Claude does the work.**

You chat with your office manager. The manager opens departments and hands out tasks. For every task that runs, a worker walks in, sits at a desk in that department and does the work for real. The results are files on the company drive that you can open and read. The manager and each department keep notes between sessions, so the office gets to know you.

```
 You (the boss) ──chat──► Manager ──creates──► Departments (Marketing, Research, Engineering…)
                             │
                             └──assigns──► Tasks ──► one Worker per running task ──► files on the drive
```

## Quick start

You need Node.js 20.12+ and a [Claude API key](https://console.anthropic.com/settings/keys).

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The first time, Settings opens so you can paste your API key. You can also put `ANTHROPIC_API_KEY=...` in a `.env` file (see `.env.example`).

Then try telling the manager something like:

> Set up Marketing, Research and Engineering departments for a coffee subscription startup, then have Marketing write a launch announcement.

### Demo mode (no API key, no cost)

```bash
npm run demo
```

In demo mode workers act out tasks and save placeholder files without calling the API. Use it to look around, or to work on the 3D scene and UI. The manager still needs a key, so create departments and tasks from the UI: click a department, then use **Hand them a task directly**.

## How it works

| Piece | What it is |
| --- | --- |
| **Manager** | One long-running Claude conversation (`server/manager.ts`). It has tools to create, update and close departments, assign and cancel tasks, read results and files, and keep notes. Every boss message starts with a live `<office_status>` block, so the manager always sees the real state of the office. |
| **Departments** | A name, a genre of work, standing instructions, a **headcount** (desks = how many of its tasks can run at once) and optional web access. You can create them yourself or have the manager do it. |
| **Workers** | One Claude agent loop per running task (`server/worker.ts`). It can read the company drive, write deliverables into its department's folder, keep department notes and, if allowed, search and read the web. Its last message becomes the task summary. |
| **Scheduler** | Starts queued tasks, oldest first, while the department has a free desk and the office is under `MAX_CONCURRENT_WORKERS` (`server/office.ts`). |
| **3D office** | React Three Fiber (`src/scene`). Every person and piece of furniture is built from primitive shapes, so there are no asset files. Workers walk in from the door, type at their desks, show their latest progress note in a speech bubble, and walk out when they finish. |

The server is the source of truth. It pushes a full snapshot over a WebSocket whenever something changes, and the browser just renders it.

### Memory

Siverse remembers at three levels:

1. **The chat.** The manager's conversation is saved to `data/manager-history.json`, so it survives restarts. **☀️ New day** clears it.
2. **Notes.** The manager and every department use [Claude's memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) on a folder on disk (`data/memory/company`, `data/memory/departments/<id>`). These survive a new day, so Marketing still remembers your brand voice next week.
3. **The work.** Everything workers make is saved as plain files in `workspace/<department>/`, and any worker can read it later.

### Models and cost

By default both the manager and the workers use **Claude Opus 5.5**. You can change either one in Settings. Each running worker is its own stream of API calls, so cost grows with how busy the office is. Setting the worker model to Claude Sonnet 5.5 or Haiku 4.5 makes a busy office much cheaper. Each task's detail card shows the tokens it used.

Requests use adaptive thinking with progress updates (`display: "updates"`), which is what fills the speech bubbles. They also use prompt caching, and server-side refusal fallbacks (`fallbacks: "default"`) on models that support them.

## Safety notes

- **Local only.** The server listens on `127.0.0.1` and rejects requests whose `Host` or `Origin` isn't localhost. Other websites can't drive your office or spend your credits. Don't expose it to a network without adding authentication.
- **Your key stays on your machine.** A key pasted into Settings is saved to `data/settings.json` with `0600` permissions and is never sent back to the browser.
- **Sandboxed files.** Workers can only write inside their own department folder under `workspace/`, and can only read inside `workspace/`. Paths that try to escape are rejected.
- `data/` and `workspace/` are git-ignored.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Optional if you paste the key in Settings instead |
| `PORT` | `8787` | API/WebSocket server port (Vite runs on 5173 in dev) |
| `HOST` | `127.0.0.1` | Bind address |
| `MAX_CONCURRENT_WORKERS` | `4` | Workers allowed at desks across the whole office |
| `SIVERSE_DEMO` | unset | `1` runs workers without the API (`npm run demo`) |

## Scripts

| Command | |
| --- | --- |
| `npm run dev` | Server + Vite with hot reload |
| `npm run demo` | Same, in demo mode |
| `npm run build` | Typecheck and build the frontend into `dist/` |
| `npm start` | Serve the built app and API from one port (`http://localhost:8787`) |

## Project layout

```
server/
  index.ts      HTTP API, WebSocket, static files
  manager.ts    the manager agent and its tools
  worker.ts     the worker agent and its tools
  office.ts     departments, tasks, scheduler
  memory.ts     file-backed memory tool
  drive.ts      sandboxed company drive
  claude.ts     per-model request settings, helpers
  store.ts      state, persistence, change notifications
  security.ts   localhost-only guard
src/
  scene/        3D office: layout, people, furniture, workers
  ui/           chat, task board, task details, modals
shared/types.ts types used by both sides
```

## Ideas for what's next

- Workers handing work to other departments, and meetings between departments
- A code-execution sandbox for Engineering
- An MCP server, so Claude Code or Claude Desktop can run the office
- Cost dashboard and per-department budgets
- Nicer characters (GLTF), sounds, day/night cycle

Contributions are welcome. Open an issue to talk about bigger changes first.

## License

[MIT](LICENSE)

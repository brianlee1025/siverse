# 🏢 Siverse

**A 3D office simulator where you are the boss and Claude does the work.**

Siverse has two modes, and they share one office:

- **⚡ Watch Claude Code** (the default) works with a Claude Pro or Max plan, no API key needed. Keep using Claude Code as usual; Siverse shows it as an office. Each project gets a zone, Claude sits at a desk with a speech bubble of what it's doing ("📖 Reading checkout.test.ts", "⌨️ Run the test suite"), and every subagent it launches walks in as another worker and leaves when it's done.
- **🏢 Run your own AI office** is optional and off until you turn it on in Settings. It needs a Claude API key. You chat with your office manager, who opens departments and hands out tasks. For every task that runs, a worker walks in, does the work for real, and saves the results as files on the company drive. The manager and each department keep notes between sessions, so the office gets to know you.

```
 Claude Code ──hooks──► Siverse ──► project zones, Claude at a desk, subagents as workers

 You (the boss) ──chat──► Manager ──creates──► Departments (Marketing, Research, Engineering…)
                             │
                             └──assigns──► Tasks ──► one Worker per running task ──► files on the drive
```

## Quick start

You need Node.js 20.12+.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>.

### Watch Claude Code (Pro/Max plan)

1. Click **Claude Code** in the top bar, then **⚡ Connect Claude Code**. Or run `npm run cc:connect` in a terminal.
2. Start a **new** Claude Code session (or restart open ones) and give it a task.
3. Watch it show up in the office. The **Claude Code** chat tab mirrors your prompts and Claude's replies.

How it works: connecting adds [hooks](https://code.claude.com/docs/en/hooks) to `~/.claude/settings.json`. On each event (session start, prompt, tool call, subagent start/stop, reply), Claude Code runs a background `curl` that posts the event to Siverse on `127.0.0.1`. **Siverse never calls Claude, never sees your login, and never sends input to Claude Code.** Claude Code runs exactly as before, on your own plan. The hooks run in the background and always succeed, so Claude Code isn't slowed down and doesn't complain when Siverse isn't running.

- `npm run cc:connect -- --project ../my-app` connects one project only (its `.claude/settings.local.json`).
- `npm run cc:disconnect` removes the hooks again. Siverse only ever touches its own entries and keeps a `.siverse-backup` of the file.

### Run your own AI office (API key)

This mode calls the Claude API, which is billed separately from Claude Pro/Max plans. Open **Settings**, switch on **AI office**, and paste a key from [console.anthropic.com](https://console.anthropic.com/settings/keys), or put `ANTHROPIC_API_KEY=...` in a `.env` file (see `.env.example`). The manager, the Manager chat tab, departments and the Drive then appear. Switch it off again to go back to just watching Claude Code. Your departments and files are kept.

Then try telling the manager something like:

> Set up Marketing, Research and Engineering departments for a coffee subscription startup, then have Marketing write a launch announcement.

### Run the AI office on your Claude plan (no API key)

In **Settings**, switch on **AI office** and choose **Claude Code on this computer**. The manager and every worker then run as the [Claude Code](https://code.claude.com) CLI on this computer (`claude -p`), on your own Claude Pro/Max login, so they count towards your plan's usage limits instead of being billed to an API key.

- Siverse finds the CLI on your `PATH`, or the copy the Claude desktop app keeps, and shows which one in Settings. Set `CLAUDE_CODE_BIN` to point it somewhere else.
- **Sign in once first.** Run that CLI in a terminal and use `/login`, so it can run on its own. (The desktop app's own copy uses the app's sign-in only while the app runs it.)
- Each worker runs in its department's folder on the drive and can only write there and in its department's notes. It can read the whole drive, and uses the web only if the department allows it. No shell, no MCP servers from your own Claude Code setup.
- The manager gets the office's tools (departments, tasks, schedules, results) through a small MCP server, `scripts/siverse-mcp.mjs`, that calls this server's local API. Its conversation is resumed for every message; **☀️ New day** starts a fresh one.
- Department notes are the same files for both engines, so switching keeps what each department has learned.
- These runs work in `workspace/` and `data/`, so the **Watch Claude Code** view leaves them out instead of showing them twice.

### Recurring tasks

Give a department a standing job on a timetable: every day at a time, a weekday each week, or every few hours (local time). Add one in the department's window, or tell the manager, e.g. *"Every Monday at 9, have Research find new padel clubs opening in the US and add them to leads.csv."* Each run is told to build on the previous runs' work and the department's notes. If the office was closed when a run was due, it runs once when Siverse starts. A run that is still going makes the next one skip. **🧹 Weekly notes tidy-up** adds a Sunday-evening job that keeps a department's notes short and current. Schedules only fire while Siverse is running.

### Demo mode (no API key, no cost)

```bash
npm run demo
```

Demo mode switches the AI office on, and its workers act out tasks and save placeholder files without calling the API. Use it to look around, or to work on the 3D scene and UI. The manager still needs a key, so create departments and tasks from the UI: click a department, then use **Hand them a task directly**.

## How it works

| Piece | What it is |
| --- | --- |
| **Manager** | One long-running Claude conversation (`server/manager.ts`). It has tools to create, update and close departments, assign and cancel tasks, read results and files, and keep notes. Every boss message starts with a live `<office_status>` block, so the manager always sees the real state of the office. |
| **Departments** | A name, a genre of work, standing instructions, a **headcount** (desks = how many of its tasks can run at once) and optional web access. You can create them yourself or have the manager do it. |
| **Workers** | One Claude agent loop per running task (`server/worker.ts`). It can read the company drive, write deliverables into its department's folder, keep department notes and, if allowed, search and read the web. Its last message becomes the task summary. |
| **Scheduler** | Starts queued tasks, oldest first, while the department has a free desk and the office is under `MAX_CONCURRENT_WORKERS` (`server/office.ts`). |
| **3D office** | React Three Fiber (`src/scene`). Every person and piece of furniture is built from primitive shapes, so there are no asset files. Workers walk in from the door, type at their desks, show their latest progress note in a speech bubble, and walk out when they finish. |

| **Claude Code bridge** | `server/claudeCode.ts` turns hook events into the office. A project folder becomes a zone, a session becomes a worker named Claude, and an event carrying an `agent_id` belongs to that subagent's own worker. Sessions with no events for 45 minutes go home. All of this lives in memory and is never saved to disk. |

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
- **Claude Code mode is read-only.** Siverse only receives what Claude Code's hooks send. It keeps short descriptions (for example "Editing app.ts", not file contents) and a feed of recent prompts and replies, in memory only.
- `data/` and `workspace/` are git-ignored.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Optional if you paste the key in Settings instead |
| `PORT` | `8787` | API/WebSocket server port (Vite runs on 5173 in dev) |
| `HOST` | `127.0.0.1` | Bind address |
| `MAX_CONCURRENT_WORKERS` | `4` | Workers allowed at desks across the whole office |
| `SIVERSE_DEMO` | unset | `1` runs workers without the API (`npm run demo`) |
| `CLAUDE_CODE_BIN` | found automatically | The Claude Code CLI to run for the "Claude Code on this computer" engine |

## Scripts

| Command | |
| --- | --- |
| `npm run dev` | Server + Vite with hot reload |
| `npm run demo` | Same, in demo mode |
| `npm run cc:connect` | Add Siverse's hooks to Claude Code (`-- --project <dir>` for one project) |
| `npm run cc:disconnect` | Remove them |
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
  claudeCode.ts       Claude Code events → office
  claudeCodeHooks.ts  add/remove hooks in Claude Code settings
scripts/
  claude-code.ts  cc:connect / cc:disconnect
src/
  scene/        3D office: layout, people, furniture, workers
  ui/           chat, task board, task details, modals
shared/types.ts types used by both sides
```

## Ideas for what's next

- Workers handing work to other departments, and meetings between departments
- A code-execution sandbox for Engineering
- Show Claude Code's to-do list and permission prompts more visibly in the office (a raised hand, a whiteboard)
- Cost dashboard and per-department budgets
- Nicer characters (GLTF), sounds, day/night cycle

Contributions are welcome. Open an issue to talk about bigger changes first.

## License

[MIT](LICENSE)

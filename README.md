# 🏢 Siverse

**A 3D office simulator where you are the boss and Claude does the work.**

<!-- Hero GIF: record ~10 s of the office in demo mode (npm run demo), with no real company data on screen, and save it as docs/hero.gif. -->
![Siverse: Claude workers at their desks in a 3D office](docs/hero.gif)

Siverse has two modes, and they share one office:

- **⚡ Watch Claude Code** (the default) works with a Claude Pro or Max plan, no API key needed. Keep using Claude Code as usual; Siverse shows it as an office. Each project gets a zone, Claude sits at a desk with a speech bubble of what it's doing ("📖 Reading checkout.test.ts", "⌨️ Run the test suite"), and every subagent it launches walks in as another worker and leaves when it's done.
- **🏢 Run your own AI office** is optional and off until you turn it on in Settings. It needs a Claude API key. You chat with your office manager, who opens departments and hands out tasks. For every task that runs, a worker walks in, does the work for real, and saves the results as files on the company drive. The manager and each department keep notes between sessions, so the office gets to know you.

```
 Claude Code ──hooks──► Siverse ──► project zones, Claude at a desk, subagents as workers

 You (the boss) ──chat──► Manager ──creates──► Departments (Marketing, Research, Engineering…)
                             │
                             └──assigns──► Tasks ──► one Worker per running task ──► files on the drive
```

## Prerequisites

- **Node.js 20.12+**
- **`curl` on your `PATH`**, for the Claude Code hooks (Windows 10+, macOS and most Linux distributions include it)
- **For the AI office on your Claude plan:** the [Claude Code](https://code.claude.com) CLI, signed in once with `/login`. Not needed to watch Claude Code or to use the API engine.

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:5173>.

## Safety notes

Siverse runs AI agents on your own computer. Read this before you switch on the AI office.

- **Local only. Never set `HOST` to anything but a local address.** The server listens on `127.0.0.1` and rejects requests whose `Host` or `Origin` isn't localhost, so other websites can't drive your office or spend your credits. It has no login: anyone who can reach the port can run your office, approve commands and change settings.
- **Any local process can post to the hook endpoint.** `/api/claude-code/hook` takes events from Claude Code without authentication, so any program on your computer can make things appear in the office. It only changes what the office shows, not what it does.
- **Workers on the Claude Code engine can currently read files anywhere on your computer**, not only the company drive. Their writes are limited to their department's folder and notes, and `.env`, `data/settings.json` and `data/tools/` are denied, but anything else your user account can read (for example `~/.ssh` or other projects) is readable. On the API engine, workers can only read inside `workspace/`.
- **Web access plus file reading is a leak risk.** A worker that reads a hostile web page can be talked into reading a file and sending its contents out in a web request. Turn on web access only for departments that need it, especially on the Claude Code engine.
- **Approved commands set to ask first "Never" run unattended.** Workers can run them with any arguments, as often as they like, without asking you. "Only when it has arguments" is only safe if running the script with no arguments is a real dry run. See [Approved commands](#approved-commands).
- **Your key stays on your machine.** A key pasted into Settings is saved to `data/settings.json` with `0600` permissions and is never sent back to the browser.
- **Writes are sandboxed.** Workers can only write in their own department folder under `workspace/` and their notes. On the API engine, paths that try to escape are rejected. On the Claude Code engine each run gets write rules for exactly those folders (never a blanket Edit/Write).
- **Code access is opt-in.** A department whose job is improving Siverse itself can be allowed, in its window, to change Siverse's own code. Its workers still can't change `data/`, `.env`, `.git`, `node_modules`, the package files or the code that enforces approvals and these rules. This prevents accidents rather than a determined worker, since any server file runs inside Siverse. Their server edits restart the office (`npm run dev` reloads), which ends any task running at the time.
- **No shell.** Workers can only run the commands you approve, which Siverse runs for them without a shell and, if you choose, only after your OK.
- **Claude Code mode is read-only.** Siverse only receives what Claude Code's hooks send. It keeps short descriptions (for example "Editing app.ts", not file contents) and a feed of recent prompts and replies, in memory only.

### What's in `data/`

Everything Siverse knows about your office lives in `data/` (and the work itself in `workspace/`). Both are git-ignored. **Never commit `data/`**: it can hold your API key, your chats and your company's notes.

| Path | What it holds |
| --- | --- |
| `settings.json` | Settings, including an API key pasted into Settings |
| `state.json` | Departments, employees, tasks, schedules and approved commands |
| `manager-history.json` | The manager's conversation (API engine) |
| `memory/` | Notes of the manager, each department and each permanent employee |
| `tools/` | The approved copies of command scripts |
| `runs/` | Per-task files for Claude Code engine runs |

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
- Each worker runs in its department's folder on the drive and can only write there and in its department's notes. It can read the whole drive and, for now, other files on your computer too (see [Safety notes](#safety-notes)). It uses the web only if the department allows it. No shell, no MCP servers from your own Claude Code setup.
- The manager gets the office's tools (departments, tasks, schedules, results) through a small MCP server, `scripts/siverse-mcp.mjs`, that calls this server's local API. Its conversation is resumed for every message; **☀️ New day** starts a fresh one.
- Department notes are the same files for both engines, so switching keeps what each department has learned.
- **Plan and usage in the top bar.** Siverse shows your plan (from `claude auth status`) and how much of its 5-hour and weekly limits is left, with reset times on hover. The numbers come from the usage report Claude Code makes on every run, so they update whenever the office works. **↻** checks now with a tiny Haiku request, which uses a sliver of your plan. Limits are per account, so this includes your other Claude use as of that moment. If the CLI isn't signed in, the top bar says so.
- These runs work in `workspace/` and `data/`, so the **Watch Claude Code** view leaves them out instead of showing them twice.

### Recurring tasks

Give a department a standing job on a timetable: every day at a time, a weekday each week, or every few hours (local time). Add one in the department's window, or tell the manager, e.g. *"Every Monday at 9, have Research find competitors that launched this week and add them to competitors.csv."* A recurring task can also belong to one permanent employee (see below). Each run is told to build on the previous runs' work and the department's notes. If the office was closed when a run was due, it runs once when Siverse starts. A run that is still going makes the next one skip. **🧹 Weekly notes tidy-up** adds a Sunday-evening job that keeps a department's notes short and current. Schedules only fire while Siverse is running.

### Follow-ups

Not quite what you wanted? Open a finished task and type in the box at the bottom of its card, e.g. *"Add two more competitors and a comparison table."* The same task goes back to work with the same worker: a permanent employee picks it up themselves, a temp comes back under the same name. They get the conversation so far and the files they already made, and update them instead of starting over. Their reply joins the conversation on the card. The manager can do the same with its `follow_up_task` tool, so you can also just ask it to "have Research add sources to the price scan". A follow-up that fails can be re-run with **Try again**.

### Approved commands

Workers have no shell. When a department needs to run something, for example a script that sends the emails it wrote, you approve that script in the department's window under **🔐 Approved commands**. Only you can do this; the manager and the workers can't. When a worker calls its `run_command` tool, Siverse runs the command itself:

- **The approved copy runs.** Siverse keeps a copy of the script in `data/tools/`, which workers can't change. If the script on the drive changes later, the window tells you, and the approved version keeps running until you read the new one and approve it.
- **No shell.** It runs as `<program> <script> <arguments>`, for example `py send_email.py --send`, in the script's folder on the drive, so the script should open its files relative to the current folder.
- **Only the variables you name.** List environment variable names, such as `SMTP_USER, SMTP_PASSWORD`, and put their values in Siverse's `.env` (read fresh on every run) or your environment. The command gets those and the basics a program needs to start, nothing else. No Claude run gets them in its environment or can read `.env`, and if a script prints one of the values, it's blanked out before the worker sees it.
- **Your OK first.** Choose when Siverse asks you: every time, only when the command has arguments, or never. "Only when it has arguments" lets workers run the script bare without asking, so use it only if a bare run is a real dry run that changes nothing. "Never" lets workers run it unattended with any arguments, for example sending email. The window shows a warning next to both. A worker that needs your OK waits on its task, which shows **Needs your OK**, with the exact command and the worker's reason, until you click **Approve and run** or **Don't run it** (up to 30 minutes).
- Each task lists the commands it ran. A command runs for one task at a time.

### Permanent employees

By default every desk is for temps: a worker walks in for one task, works with the department's shared notes, and leaves. You can also hire **permanent employees** into a department, in its window under **👥 Team** or by telling the manager, e.g. *"Hire someone in Research to focus on competitor pricing."*

- Each one keeps **their own desk** (hiring adds a desk if every desk is taken) and has **their own area** within the department's work. You or the manager can change it at any time.
- Each one keeps **their own notes** in `data/memory/employees/<id>/`, alongside the department's shared notes: what they know about their area and a log of the tasks they have done. So they get better at their area over time.
- Give them work by name: pick them under **For** when you hand the department a task, under **Done by** on a recurring task, or tell the manager *"have Ava check this week's prices."* They do one task at a time, and the rest waits for them. Work without a name goes to a temp at a free desk, or to a free employee.
- Between tasks they stay in the office, strolling the corridors or relaxing at their desk, and head back to their desk when work comes in.
- **Fire** someone from their row in the Team list: their desk stays for temps, and work waiting for them goes to whoever is free. You choose whether to keep or delete their notes. The manager can also let people go, but it always keeps their notes.

### Demo mode (no API key, no cost)

```bash
npm run demo
```

Demo mode switches the AI office on, and its workers act out tasks and save placeholder files without calling the API. Use it to look around, or to work on the 3D scene and UI. The manager still needs a key, so create departments and tasks from the UI: click a department, then use **Hand them a task directly**.

## How it works

| Piece | What it is |
| --- | --- |
| **Manager** | One long-running Claude conversation (`server/manager.ts`). It has tools to create, update and close departments, hire, brief and let go of permanent employees, assign and cancel tasks, read results and files, and keep notes. Every boss message starts with a live `<office_status>` block, so the manager always sees the real state of the office. |
| **Departments** | A name, a genre of work, standing instructions, a **headcount** (desks = how many of its tasks can run at once) and optional web access. You can create them yourself or have the manager do it. Only you can turn web access on with the API engine; the manager can only turn it off. |
| **Workers** | One Claude agent loop per running task (`server/worker.ts`). It can read the company drive, write deliverables into its department's folder, keep department notes and, if allowed, search and read the web. Its last message becomes the task summary. |
| **Employees** | Permanent members of a department (`server/employees.ts`): a name, an area of focus, a desk of their own and their own notes. Tasks and schedules can name one. |
| **Scheduler** | Starts queued tasks, oldest first, while the department has a free desk and the office is under `MAX_CONCURRENT_WORKERS` (`server/office.ts`). A task for an employee waits for them; any other task goes to a temp at a desk nobody owns, or else to a free employee. |
| **3D office** | React Three Fiber (`src/scene`). Every person and piece of furniture is built from primitive shapes, so there are no asset files. Temps walk in from the door, type at their desks, show their latest progress note in a speech bubble, and walk out when they finish. Permanent employees (★) stay, wandering or relaxing until their next task. |
| **Claude Code bridge** | `server/claudeCode.ts` turns hook events into the office. A project folder becomes a zone, a session becomes a worker named Claude, and an event carrying an `agent_id` belongs to that subagent's own worker. Sessions with no events for 45 minutes go home. All of this lives in memory and is never saved to disk. |

The server is the source of truth. It pushes a full snapshot over a WebSocket whenever something changes, and the browser just renders it.

### Memory

Siverse remembers at three levels:

1. **The chat.** The manager's conversation is saved to `data/manager-history.json`, so it survives restarts. **☀️ New day** clears it.
2. **Notes.** The manager and every department use [Claude's memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) on a folder on disk (`data/memory/company`, `data/memory/departments/<id>`). Each permanent employee also has their own (`data/memory/employees/<id>`), which they see as `/memories/me/` next to the department's `/memories/team/`. These survive a new day, so Marketing still remembers your brand voice next week.
3. **The work.** Everything workers make is saved as plain files in `workspace/<department>/`, and any worker can read it later.

### Models and cost

By default both the manager and the workers use **Claude Opus 5.5**. You can change either one in Settings. Each running worker is its own stream of API calls, so cost grows with how busy the office is. Setting the worker model to Claude Sonnet 5.5 or Haiku 4.5 makes a busy office much cheaper. Each task's detail card shows the tokens it used.

Requests use adaptive thinking with progress updates (`display: "updates"`), which is what fills the speech bubbles. They also use prompt caching, and server-side refusal fallbacks (`fallbacks: "default"`) on models that support them.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Optional if you paste the key in Settings instead |
| `PORT` | `8787` | API/WebSocket server port (Vite runs on 5173 in dev) |
| `HOST` | `127.0.0.1` | Bind address. Keep it local: the server has no login |
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
  index.ts            HTTP API, WebSocket, static files
  manager.ts          the manager agent and its tools (API engine)
  ccManager.ts        the manager on the Claude Code engine
  worker.ts           the worker agent and its tools (API engine)
  ccWorker.ts         a worker on the Claude Code engine (one `claude -p` run per task)
  taskBrief.ts        what a worker is told about its task, including follow-ups
  claudeCli.ts        finds and runs the Claude Code CLI, permission rules for its runs
  planUsage.ts        your Claude plan and usage limits for the top bar
  office.ts           departments, tasks, scheduler
  schedules.ts        recurring and chained tasks
  employees.ts        permanent employees: hire, brief, fire
  commands.ts         approved commands: the only things workers can run
  memory.ts           file-backed memory tool
  drive.ts            sandboxed company drive
  claude.ts           per-model request settings, helpers
  settings.ts         settings, API key, engine choice
  config.ts           paths, environment variables, limits
  store.ts            state, persistence, change notifications
  security.ts         localhost-only guard
  names.ts            worker first names
  demo.ts             demo mode: workers act out tasks without the API
  claudeCode.ts       Claude Code events → office
  claudeCodeHooks.ts  add/remove hooks in Claude Code settings
scripts/
  claude-code.ts           cc:connect / cc:disconnect
  siverse-mcp.mjs          the office's tools as an MCP server for the Claude Code manager
  siverse-worker-mcp.mjs   run_command as an MCP server for Claude Code workers
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

Contributions are welcome. Open an issue to talk about bigger changes first, and see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

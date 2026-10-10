# Contributing to Siverse

Thanks for helping. For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Dev setup

You need Node.js 20.12+ (see [Prerequisites](README.md#prerequisites)).

```bash
npm install
npm run dev     # server on :8787 and Vite on :5173, both with hot reload
```

Open <http://localhost:5173>. To work on the 3D scene or UI without an API key or plan usage, use demo mode (`npm run demo`, see the README). Server changes restart the office, which ends any task running at the time.

## Before you open a pull request

```bash
npm run typecheck
npm run build
```

Both must pass. CI runs the same checks on Node 20 and 22.

Keep pull requests focused, and match the style of the surrounding code. If you change how workers are sandboxed or how approved commands run, say so clearly in the pull request: those files enforce the safety rules in the README.

## Never commit

- **`data/`**: settings (possibly your API key), chats, notes and approved scripts.
- **`workspace/`**: the files your office made.
- **`.env` or any `.env.*` file** other than `.env.example`.

They are all git-ignored. Check `git status` before you commit anyway.

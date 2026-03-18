# Claude Code Manager - Agent Instructions

This file should stay aligned with `CLAUDE.md`.
If `AGENTS.md` and `CLAUDE.md` ever diverge, the agent should treat that as documentation drift and sync them immediately.

## HARD RULES — READ FIRST

1. **NEVER run `pm2 restart`, `pm2 reload`, or any `pm2` command directly.** This can kill running sub-task PTY processes. Deploy via `./deploy.sh` after pushing to `origin/main`, or via `POST /api/deploy` when using the app.
2. **Frontend changes under `client/` do NOT require a server restart.** After `npm run build`, the updated files are live immediately.
3. **Only backend/runtime changes require a deploy**, and even then, prefer `./deploy.sh` or `POST /api/deploy` rather than direct process management.

## Project Layout

- `server/` — API, session/chat runtime control, SQLite, PTY management
- `client/` — React + xterm.js + Tailwind CSS
- `deploy.sh` — production deploy entrypoint

## Deployment

- Production is remote-only.
- Push the exact commit to `origin/main` before running `./deploy.sh`.
- Running something locally does not change production state.

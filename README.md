# Claude Code Manager

Web-based management interface for running multiple Claude Code sessions in parallel. Uses tmux as middleware so you can interact with Claude Code from both the browser (xterm.js) and native terminals (iTerm2/Warp).

## Architecture

```
Browser (React + xterm.js)
    ↕ socket.io
Express Server (Node.js)
    ↕ node-pty
tmux sessions (one per task)
    ↕
Claude Code / Ralph autonomous loop
```

- **SQLite** as primary database for fast reads/writes
- **Notion** as async sync target (optional, non-blocking)
- **tmux** decouples Claude Code processes from the web server — sessions survive server restarts
- **claude-workflow** auto-initialized in each worktree on task start

## Features

- Manage multiple projects and tasks from a single dashboard
- Start Claude Code in interactive mode or Ralph autonomous loop mode
- Real-time terminal in browser via xterm.js
- Attach to the same session from native terminal: `tmux attach -t <session>`
- Git worktree support for parallel feature development
- PROGRESS.md file watching with Notion sync
- Session recovery on server restart
- One-click deploy to remote server

## Quick Start

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Development
cd client && npm run dev &   # Frontend on :5173
npm run dev                   # Server on :3000

# UI mobile guard (optional, in another terminal)
npm run ui:mobile:watch

# Production build
npm run build
npm run dev
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `ACCESS_TOKEN` | Bearer token for API auth (optional) |
| `NOTION_TOKEN` | Notion integration token (optional) |
| `NOTION_PROJECTS_DB` | Notion Projects database ID |
| `NOTION_TASKS_DB` | Notion Tasks database ID |
| `WORKFLOW_DIR` | Path to claude-workflow (default: `~/Documents/claude-workflow`) |

## Notion Setup (Optional)

Create two databases in Notion:

**Projects Database** — properties:
- Name (title), Repo Path (text), SSH Host (text), Status (select: active/archived)

**Tasks Database** — properties:
- Title (title), Status (select: pending/in_progress/done/interrupted), Project (relation → Projects), Branch (text), Model (select), Mode (select: claude/ralph)

Then create a Notion integration at https://www.notion.so/my-integrations, share both databases with it, and fill in `.env`.

## Deploy to Server

```bash
# Prerequisites on server: Node.js 18+, tmux, pm2
# Configure SSH in ~/.ssh/config (e.g. Host tencent)

# Edit deploy.sh with your server alias and path
chmod +x deploy.sh
./deploy.sh
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/tasks?projectId=` | List tasks |
| POST | `/api/tasks` | Create task |
| POST | `/api/tasks/:id/start` | Start Claude Code session |
| POST | `/api/tasks/:id/stop` | Stop session |

## Tech Stack

- **Server**: Express, socket.io, node-pty, better-sqlite3
- **Client**: React, xterm.js, Tailwind CSS, Vite
- **Infra**: tmux, pm2, GitHub webhook auto-deploy

## Mobile UI Adaptation Guard

- `npm run ui:mobile:watch`: watch `client/src` and auto-run mobile checks after UI edits
- `npm run ui:mobile:check`: one-shot check (`mobile:check` + frontend build)
- `client/scripts/mobile-check.mjs` scans UI code for mobile risk patterns (fixed large size, `100vh`)

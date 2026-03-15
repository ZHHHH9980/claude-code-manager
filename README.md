# Claude Code Manager

Web UI for running and supervising multiple Claude Code / Codex sessions in parallel. The current product is terminal-first: projects and tasks are managed in the browser, each running task gets a PTY-backed terminal, and the home screen also exposes a main agent terminal. Session recovery, buffered replay, adapter selection, and lightweight persistence are built in.

## Architecture

```mermaid
graph TB
    subgraph Browser["Browser (React)"]
        PL[ProjectList]
        TB[TaskBoard]
        TT["Task Terminal Modal"]
        AT["Agent Terminal"]
    end

    subgraph Static["Static Server :8080"]
        SS[client/dist]
    end

    subgraph API["API + socket.io :3000"]
        REST[REST API]
        SIO[WebSocket Terminal I/O]
        SSE[SSE Streams]
        PTY[PTY Manager]
        DB[(SQLite)]
        AD[Adapter Registry]
        FW[PROGRESS Watcher]
    end

    subgraph CLI["CLI Processes"]
        CC[Claude CLI]
        CX[Codex CLI]
    end

    SS --> Browser
    PL -->|REST| REST
    TB -->|REST| REST
    TT <-->|WebSocket| SIO
    AT <-->|WebSocket| SIO
    Browser -->|SSE| SSE

    REST --> DB
    SSE --> DB
    SIO <--> PTY
    PTY --> AD
    AD --> CC
    AD --> CX
    REST --> FW
```

Communication in the live system uses three patterns:

- REST for project/task CRUD and control operations
- WebSocket for interactive terminal I/O
- SSE for agent chat, task chat, and terminal streaming/embed endpoints

Detailed reference:

- [`ARCHITECTURE.md`](ARCHITECTURE.md)

## Current Product Shape

- Browser UI with `ProjectList`, `TaskBoard`, task terminal modal, and a persistent home agent terminal
- Adapter-driven task startup for `claude` and `codex`
- PTY session buffering and replay on reconnect
- Session recovery after API restarts
- SQLite-backed persistence for projects, tasks, chat history, and agent session state
- Optional Notion sync and `PROGRESS.md` file watching

Note: task-scoped chat still exists on the backend, but the active UI flow is centered on terminals rather than a dedicated task chat panel.

## Quick Start

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Configure
cp .env.example .env

# Development
cd client && npm run dev    # Frontend :5173 (Vite)
npm run dev                 # API :3000

# Production build
npm run build

# Production processes
pm2 start server/index.js --name claude-manager-api
pm2 start static-server.js --name claude-manager-static
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `3000` |
| `STATIC_PORT` | Static server port | `8080` |
| `FRONTEND_URL` | Allowed frontend origins for CORS | local/default allows localhost-style origins |
| `ACCESS_TOKEN` | Optional bearer token for API auth | unset |
| `DB_PATH` | SQLite database path | `data/manager.db` |
| `WORKFLOW_DIR` | Path to `claude-workflow` | `~/Documents/claude-workflow` |
| `TASK_USER` | User to run PTY tasks as when service runs as root | current service user |
| `NOTION_TOKEN` | Notion integration token | unset |
| `NOTION_PROJECTS_DB` | Notion Projects database ID | unset |
| `NOTION_TASKS_DB` | Notion Tasks database ID | unset |

## Tech Stack

- Backend: Express, socket.io, node-pty, better-sqlite3, chokidar
- Frontend: React 18, xterm.js, Tailwind CSS, Vite
- Streaming: WebSocket and SSE
- Runtime: Claude CLI, Codex CLI, PM2
- Persistence: SQLite and on-disk PTY buffers

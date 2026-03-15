# Configuration

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

## Runtime Notes

- `PORT` serves the API and socket.io server.
- `STATIC_PORT` serves the built frontend from `static-server.js`.
- `FRONTEND_URL` controls CORS allowlisting for browser clients.
- `ACCESS_TOKEN` protects API routes except the GitHub webhook endpoint.
- `WORKFLOW_DIR` points to the external `claude-workflow` checkout used during task startup.
- Notion variables are optional and only used when Notion sync is enabled.

## Production Runtime

- Backend: Express, socket.io, node-pty, better-sqlite3, chokidar
- Frontend: React 18, xterm.js, Tailwind CSS, Vite
- Streaming: WebSocket and SSE
- Runtime: Claude CLI, Codex CLI, PM2
- Persistence: SQLite and on-disk PTY buffers

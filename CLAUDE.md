# Claude Code Manager - Agent Context

## HARD RULES — READ FIRST

1. **NEVER run `pm2 restart`, `pm2 reload`, or any pm2 command directly.** This kills all running sub-task PTY processes. Deploy via `POST /api/deploy` instead.
2. **Frontend changes (`client/`) do NOT require a server restart.** Express serves static files from `client/dist/` — after `npm run build` the new files are live immediately.
3. **Only `server/` changes require a server restart**, and even then, use `deploy.sh` which handles this automatically.

## Architecture

- `server/` — Express + socket.io + SQLite + node-pty (PTY session management)
- `client/` — React + xterm.js + Tailwind CSS (static files served by Express)
- `deploy.sh` — smart deploy: only restarts server when `server/` files changed
- `POST /api/deploy` — triggers deploy on the remote server

## Database

SQLite at `data/manager.db`.

Tables:
- `projects`: id, name, repo_path, ssh_host, notion_id, created_at
- `tasks`: id, title, status (pending/in_progress/done/interrupted), project_id, branch, worktree_path, pty_session, model, mode, notion_id, created_at, updated_at

```sql
SELECT id, name, repo_path FROM projects;
SELECT id, title, status, branch FROM tasks WHERE project_id = '<id>';
INSERT INTO tasks (id, title, status, project_id, branch, created_at, updated_at) VALUES (hex(randomblob(7)), '<title>', 'pending', '<project_id>', '<branch>', datetime('now'), datetime('now'));
UPDATE tasks SET status = '<status>', updated_at = datetime('now') WHERE id = '<id>';
```

## Server API (port 3000)

- GET /api/projects
- POST /api/projects {name, repoPath}
- GET /api/tasks?projectId=
- POST /api/tasks {title, projectId, branch}
- POST /api/tasks/:id/start {worktreePath, branch, model, mode}
- POST /api/tasks/:id/stop
- POST /api/deploy — triggers deploy.sh remotely (use this, never pm2 directly)

## What You Can Do

- Manage projects and tasks (create, list, update status)
- Read and modify CCM source code
- Run shell commands and git operations
- Deploy via `POST /api/deploy` (never pm2 directly)

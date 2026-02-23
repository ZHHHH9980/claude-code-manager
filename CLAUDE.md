# Claude Code Manager - Agent Context

You are the CCM agent running inside the Claude Code Manager project.

## Database

SQLite database at `data/manager.db`. Use `sqlite3 data/manager.db` to query.

Tables:
- `projects`: id, name, repo_path, ssh_host, notion_id, created_at
- `tasks`: id, title, status (pending/in_progress/done/interrupted), project_id, branch, worktree_path, tmux_session, model, mode, notion_id, created_at, updated_at

Common queries:
```sql
-- List projects
SELECT id, name, repo_path FROM projects;

-- List tasks for a project
SELECT id, title, status, branch FROM tasks WHERE project_id = '<id>';

-- Create task
INSERT INTO tasks (id, title, status, project_id, branch, created_at, updated_at) VALUES (hex(randomblob(7)), '<title>', 'pending', '<project_id>', '<branch>', datetime('now'), datetime('now'));

-- Update task status
UPDATE tasks SET status = '<status>', updated_at = datetime('now') WHERE id = '<id>';
```

## Server API

The Express server runs on port 3000:
- GET /api/projects
- POST /api/projects {name, repoPath}
- GET /api/tasks?projectId=
- POST /api/tasks {title, projectId, branch}
- POST /api/tasks/:id/start {worktreePath, branch, model, mode}
- POST /api/tasks/:id/stop
- POST /api/deploy (self-deploy: git pull + build + restart)

## Project Structure

- `server/` - Express + socket.io + SQLite + tmux session management
- `client/` - React + xterm.js + Tailwind CSS
- `deploy.sh` - rsync deploy to server
- Webhook auto-deploy on git push via ghfast.top mirror

## What You Can Do

- Manage projects and tasks (create, list, update status)
- Read and modify CCM source code
- Run shell commands
- Manage git operations
- Start/stop Claude Code sessions via API
- Deploy changes
- Answer questions about current progress

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/manager.db');

// Ensure data directory exists
require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT,
    ssh_host TEXT,
    notion_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    project_id TEXT,
    branch TEXT,
    worktree_path TEXT,
    tmux_session TEXT,
    model TEXT DEFAULT 'claude-sonnet-4-5',
    mode TEXT DEFAULT 'claude',
    notion_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS task_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );
`);

function ensureTaskSchema() {
  const cols = db.prepare("PRAGMA table_info('tasks')").all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('chat_session_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN chat_session_id TEXT');
  }
}

ensureTaskSchema();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function createProject(data) {
  const id = uid();
  db.prepare('INSERT INTO projects (id, name, repo_path, ssh_host) VALUES (?, ?, ?, ?)').run(
    id, data.name, data.repoPath || '', data.sshHost || ''
  );
  return { id, ...data };
}

function updateProject(id, data) {
  const fields = [];
  const values = [];
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.repo_path !== undefined) { fields.push('repo_path = ?'); values.push(data.repo_path); }
  if (data.ssh_host !== undefined) { fields.push('ssh_host = ?'); values.push(data.ssh_host); }
  if (fields.length === 0) return getProject(id);
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getProject(id);
}

function getTasks(projectId) {
  if (projectId) {
    return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  }
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function createTask(data) {
  const id = uid();
  db.prepare(
    'INSERT INTO tasks (id, title, project_id, branch, model, mode) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, data.title, data.projectId, data.branch || '', data.model || 'claude-sonnet-4-5', data.mode || 'claude');
  return getTask(id);
}

function updateTask(id, updates) {
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${col} = ?`);
    values.push(val);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTask(id);
}

function getTaskChatMessages(taskId, limit = 200) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
  return db.prepare(
    `SELECT role, text, created_at
     FROM task_chat_messages
     WHERE task_id = ?
     ORDER BY id ASC
     LIMIT ?`
  ).all(taskId, safeLimit);
}

function appendTaskChatMessage(taskId, role, text) {
  const safeRole = role === 'assistant' ? 'assistant' : 'user';
  const safeText = String(text || '').trim();
  if (!safeText) return;
  db.prepare(
    'INSERT INTO task_chat_messages (task_id, role, text) VALUES (?, ?, ?)'
  ).run(taskId, safeRole, safeText);
}

function clearTaskChatMessages(taskId) {
  db.prepare('DELETE FROM task_chat_messages WHERE task_id = ?').run(taskId);
}

function deleteProject(id) {
  const tasks = db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(id);
  for (const t of tasks) {
    db.prepare('DELETE FROM task_chat_messages WHERE task_id = ?').run(t.id);
  }
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}

function deleteTask(id) {
  db.prepare('DELETE FROM task_chat_messages WHERE task_id = ?').run(id);
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = {
  getProjects,
  getProject,
  createProject,
  updateProject,
  getTasks,
  getTask,
  createTask,
  updateTask,
  getTaskChatMessages,
  appendTaskChatMessage,
  clearTaskChatMessages,
  deleteProject,
  deleteTask,
};

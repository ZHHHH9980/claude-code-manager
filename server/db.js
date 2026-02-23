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
`);

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

module.exports = { getProjects, getProject, createProject, getTasks, getTask, createTask, updateTask };

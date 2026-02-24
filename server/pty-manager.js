// Task-terminal critical module — changes gated by pre-commit smoke tests
const pty = require('node-pty');

const sessions = new Map();

// Task sessions run as this non-root user so --dangerously-skip-permissions works
const TASK_USER = process.env.TASK_USER || 'ccm';

function isAlive(entry) {
  return Boolean(entry?.ptyProcess) && !entry.closed;
}

function removeSession(sessionName) {
  const entry = sessions.get(sessionName);
  if (!entry) return;
  entry.closed = true;
  sessions.delete(sessionName);
}

function createSession(sessionName, cwd) {
  if (sessionExists(sessionName)) {
    throw new Error(`session ${sessionName} already exists`);
  }

  const safeCwd = JSON.stringify(cwd || process.env.HOME || '/');
  const bootstrap = [
    '. ~/.bash_profile 2>/dev/null || true',
    'export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LC_CTYPE=en_US.UTF-8',
    `cd ${safeCwd}`,
    'exec bash -li',
  ].join('; ');

  // One task = one dedicated claude process tree (no tmux multiplexing).
  const ptyProcess = pty.spawn('su', ['-', TASK_USER, '-c', bootstrap], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.HOME,
    env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' },
  });

  const entry = {
    ptyProcess,
    clients: new Set(),
    lastCols: ptyProcess.cols,
    lastRows: ptyProcess.rows,
    closed: false,
    exitDisposable: null,
  };
  entry.exitDisposable = ptyProcess.onExit(() => removeSession(sessionName));
  sessions.set(sessionName, entry);
  return entry;
}

function sessionExists(sessionName) {
  const entry = sessions.get(sessionName);
  return isAlive(entry);
}

function ensureSession(sessionName, cwd) {
  const existing = sessions.get(sessionName);
  if (isAlive(existing)) {
    return existing;
  }
  return createSession(sessionName, cwd);
}

function attachSession(sessionName) {
  const entry = sessions.get(sessionName);
  if (isAlive(entry)) return entry;
  throw new Error(`session ${sessionName} not found`);
}

function resizeSession(sessionName, cols, rows) {
  const entry = sessions.get(sessionName);
  if (!isAlive(entry)) return;
  if (entry.lastCols === cols && entry.lastRows === rows) return;

  entry.ptyProcess.resize(cols, rows);
  entry.lastCols = cols;
  entry.lastRows = rows;
}

function sendInput(sessionName, data) {
  const entry = sessions.get(sessionName);
  if (isAlive(entry)) entry.ptyProcess.write(data);
}

function killSession(sessionName) {
  const entry = sessions.get(sessionName);
  if (!entry) return;
  try { entry.exitDisposable?.dispose?.(); } catch {}
  entry.exitDisposable = null;
  entry.closed = true;
  try { entry.ptyProcess.kill(); } catch {}
  sessions.delete(sessionName);
}

function getTmuxAttachCmd(sessionName) {
  return `direct-pty:${sessionName}`;
}

function listAliveSessions() {
  return Array.from(sessions.entries())
    .filter(([, entry]) => isAlive(entry))
    .map(([sessionName]) => sessionName);
}

module.exports = {
  createSession,
  attachSession,
  ensureSession,
  sessionExists,
  sendInput,
  resizeSession,
  killSession,
  getTmuxAttachCmd,
  listAliveSessions,
  sessions,
};

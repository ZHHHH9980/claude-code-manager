// Task-terminal critical module — changes gated by pre-commit smoke tests
const os = require('os');
const pty = require('node-pty');
const { StringDecoder } = require('string_decoder');

const sessions = new Map();
const MAX_OUTPUT_BUFFER = Number(process.env.PTY_OUTPUT_BUFFER_MAX || 300000);

const CURRENT_USER = process.env.SUDO_USER || process.env.USER || os.userInfo().username;
const IS_ROOT = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
// Default to the current service user to avoid cross-user su when running non-root.
const TASK_USER = process.env.TASK_USER || CURRENT_USER;

function isAlive(entry) {
  return Boolean(entry?.ptyProcess) && !entry.closed;
}

function removeSession(sessionName) {
  const entry = sessions.get(sessionName);
  if (!entry) return;
  entry.closed = true;
  try { entry.dataDisposable?.dispose?.(); } catch {}
  entry.dataDisposable = null;
  try {
    const tail = entry.outputDecoder?.end?.();
    if (tail) {
      entry.outputBuffer += tail;
      if (entry.outputBuffer.length > MAX_OUTPUT_BUFFER) {
        entry.outputBuffer = entry.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
      }
    }
  } catch {}
  entry.outputDecoder = null;
  try { entry.exitDisposable?.dispose?.(); } catch {}
  entry.exitDisposable = null;
  sessions.delete(sessionName);
}

function createSession(sessionName, cwd) {
  if (sessionExists(sessionName)) {
    throw new Error(`session ${sessionName} already exists`);
  }

  const safeCwd = JSON.stringify(cwd || process.env.HOME || '/');
  const bootstrap = [
    '. ~/.profile 2>/dev/null || true',
    '. ~/.bash_profile 2>/dev/null || true',
    '. ~/.bashrc 2>/dev/null || true',
    'export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LC_CTYPE=en_US.UTF-8',
    `cd ${safeCwd}`,
    'exec bash -li',
  ].join('; ');

  const runAsCurrentUser = !IS_ROOT || TASK_USER === CURRENT_USER;
  const cmd = runAsCurrentUser ? 'bash' : 'su';
  const args = runAsCurrentUser ? ['-lc', bootstrap] : ['-', TASK_USER, '-c', bootstrap];
  // One task = one dedicated claude process tree.
  const ptyProcess = pty.spawn(cmd, args, {
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
    outputBuffer: '',
    outputDecoder: new StringDecoder('utf8'),
    dataDisposable: null,
    exitDisposable: null,
  };
  entry.dataDisposable = ptyProcess.onData((data) => {
    if (entry.closed || data == null) return;
    const text = Buffer.isBuffer(data) ? entry.outputDecoder.write(data) : String(data);
    if (!text) return;
    entry.outputBuffer += text;
    if (entry.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      entry.outputBuffer = entry.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }
    for (const socket of entry.clients) {
      try { socket.emit(`terminal:data:${sessionName}`, text); } catch {}
    }
  });
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
  try { entry.dataDisposable?.dispose?.(); } catch {}
  entry.dataDisposable = null;
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

function getBufferedOutput(sessionName) {
  const entry = sessions.get(sessionName);
  if (!isAlive(entry)) return '';
  return entry.outputBuffer || '';
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
  getBufferedOutput,
  sessions,
};

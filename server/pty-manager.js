// Task-terminal critical module — changes gated by pre-commit smoke tests
const pty = require('node-pty');
const { execSync } = require('child_process');

const sessions = new Map();

// Task sessions run as this non-root user so --dangerously-skip-permissions works
const TASK_USER = process.env.TASK_USER || 'ccm';

function asUser(cmd) {
  // Source .bash_profile to ensure env vars (ANTHROPIC_*) are available
  return `su - ${TASK_USER} -c ${JSON.stringify(`. ~/.bash_profile 2>/dev/null; ${cmd}`)}`;
}

function tmuxSessionExists(name) {
  try {
    execSync(asUser(`tmux has-session -t ${name} 2>/dev/null`));
    return true;
  } catch {
    return false;
  }
}

function createSession(sessionName, cwd) {
  if (tmuxSessionExists(sessionName)) {
    throw new Error(`tmux session ${sessionName} already exists`);
  }
  execSync(asUser(`LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LC_CTYPE=en_US.UTF-8 tmux -u new-session -d -s ${sessionName} -c "${cwd}"`));
  // tmux may reuse an existing server process; force locale on this session explicitly.
  try { execSync(asUser(`tmux set-environment -t ${sessionName} LANG en_US.UTF-8`)); } catch {}
  try { execSync(asUser(`tmux set-environment -t ${sessionName} LC_ALL en_US.UTF-8`)); } catch {}
  try { execSync(asUser(`tmux set-environment -t ${sessionName} LC_CTYPE en_US.UTF-8`)); } catch {}
  return attachSession(sessionName);
}

function sessionExists(sessionName) {
  return tmuxSessionExists(sessionName);
}

function ensureSession(sessionName, cwd) {
  if (tmuxSessionExists(sessionName)) {
    return attachSession(sessionName);
  }
  return createSession(sessionName, cwd);
}

function attachSession(sessionName) {
  if (sessions.has(sessionName)) {
    return sessions.get(sessionName);
  }
  // Spawn as TASK_USER so --dangerously-skip-permissions is allowed.
  // -u forces tmux client output in UTF-8 even if locale detection is wrong.
  const ptyProcess = pty.spawn('su', ['-', TASK_USER, '-c', `tmux -u attach-session -t ${sessionName}`], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.HOME,
    encoding: null,
    env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' },
  });
  const entry = { ptyProcess, clients: new Set() };
  sessions.set(sessionName, entry);
  return entry;
}

function resizeSession(sessionName, cols, rows) {
  const entry = sessions.get(sessionName);
  if (entry) entry.ptyProcess.resize(cols, rows);
}

function sendInput(sessionName, data) {
  const entry = sessions.get(sessionName);
  if (entry) entry.ptyProcess.write(data);
}

function killSession(sessionName) {
  try { execSync(asUser(`tmux kill-session -t ${sessionName}`)); } catch {}
  const entry = sessions.get(sessionName);
  if (entry) {
    entry.ptyProcess.kill();
    sessions.delete(sessionName);
  }
}

function getTmuxAttachCmd(sessionName) {
  return `su - ${TASK_USER} -c "tmux -u attach -t ${sessionName}"`;
}

function listAliveSessions() {
  try {
    const out = execSync(asUser('tmux list-sessions -F "#{session_name}"')).toString();
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
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

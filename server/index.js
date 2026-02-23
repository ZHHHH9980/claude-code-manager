require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');
const { execSync, exec, spawn } = require('child_process');
const db = require('./db');
const { syncTaskToNotion } = require('./notion-sync');
const ptyManager = require('./pty-manager');
const { watchProgress, unwatchProgress } = require('./file-watcher');

const WORKFLOW_DIR = process.env.WORKFLOW_DIR || path.join(process.env.HOME, 'Documents/claude-workflow');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

app.use((req, res, next) => {
  if (req.path === '/api/webhook/github') return next();
  const token = process.env.ACCESS_TOKEN;
  if (!token) return next();
  const auth = req.headers.authorization;
  if (auth === `Bearer ${token}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

app.use(express.static(path.join(__dirname, '../client/dist')));

// Projects
app.get('/api/projects', (req, res) => {
  res.json(db.getProjects());
});

app.post('/api/projects', (req, res) => {
  const project = db.createProject(req.body);
  res.json(project);
});

// Tasks
app.get('/api/tasks', (req, res) => {
  const { projectId } = req.query;
  res.json(db.getTasks(projectId));
});

app.post('/api/tasks', (req, res) => {
  const task = db.createTask(req.body);
  syncTaskToNotion(task);
  res.json(task);
});

app.post('/api/tasks/:id/start', (req, res) => {
  const { id } = req.params;
  const { worktreePath, branch, model, mode } = req.body;
  const sessionName = `claude-${branch.replace(/\//g, '-')}`;

  const task = db.updateTask(id, {
    status: 'in_progress',
    worktreePath,
    tmuxSession: sessionName,
  });
  syncTaskToNotion(task);

  // Initialize claude-workflow in worktree
  try {
    execSync(`${WORKFLOW_DIR}/install.sh init`, { cwd: worktreePath, stdio: 'ignore' });
  } catch (e) {
    console.log('Workflow init skipped or already done');
  }

  ptyManager.createSession(sessionName, worktreePath);
  setTimeout(() => {
    if (mode === 'ralph') {
      ptyManager.sendInput(sessionName, `./ralph.sh --tool claude\n`);
    } else {
      ptyManager.sendInput(sessionName, `claude --model ${model || 'claude-sonnet-4-5'}\n`);
    }
  }, 500);

  watchProgress(worktreePath, id);
  res.json({ sessionName, tmuxCmd: ptyManager.getTmuxAttachCmd(sessionName) });
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const { id } = req.params;
  const task = db.getTask(id);
  if (task?.tmux_session) ptyManager.killSession(task.tmux_session);
  if (task?.worktree_path) unwatchProgress(task.worktree_path);
  const updated = db.updateTask(id, { status: 'done' });
  syncTaskToNotion(updated);
  res.json({ ok: true });
});

function logChatMetric(event, payload) {
  console.log(`[chat-metric] ${JSON.stringify({ event, ...payload })}`);
}

function isoNow(ts = Date.now()) {
  return new Date(ts).toISOString();
}

function buildTaskScopedPrompt(task, project, userMessage, history = []) {
  const normalizedHistory = Array.isArray(history)
    ? history
      .filter((entry) => (entry?.role === 'user' || entry?.role === 'assistant') && String(entry?.text || '').trim())
      .slice(-24)
      .map((entry) => ({
        role: entry.role === 'assistant' ? 'assistant' : 'user',
        text: String(entry.text).trim(),
      }))
    : [];

  const historyLines = normalizedHistory.length > 0
    ? [
      '',
      'Conversation history (oldest first):',
      ...normalizedHistory.map((entry, idx) => `${idx + 1}. [${entry.role}] ${entry.text}`),
    ]
    : ['', 'Conversation history: (empty)'];

  const lines = [
    'You are in Task Session Chat. Strict scope rules:',
    '1) Only discuss and act on the current task shown below.',
    '2) Do NOT query/list/summarize other tasks unless the user explicitly asks to compare across tasks.',
    '3) If user asks progress/status, report only current task progress.',
    '4) If information is missing for current task, ask a focused follow-up question.',
    '',
    'Current task context:',
    `- task_id: ${task?.id || ''}`,
    `- title: ${task?.title || ''}`,
    `- status: ${task?.status || ''}`,
    `- branch: ${task?.branch || ''}`,
    `- tmux_session: ${task?.tmux_session || ''}`,
    `- project_id: ${task?.project_id || ''}`,
    `- project_name: ${project?.name || ''}`,
    ...historyLines,
    '',
    'Current user message:',
    String(userMessage || '').trim(),
  ];
  return lines.join('\n');
}

function startClaudeStream({ cwd, message, onProcess, scope, taskId = null }, res) {
  const requestId = randomUUID();
  const startedAtMs = Date.now();
  let firstTokenAtMs = null;
  let chunkCount = 0;
  let doneLogged = false;

  function finalize(reason, extra = {}) {
    if (doneLogged) return;
    doneLogged = true;
    const finishedAtMs = Date.now();
    logChatMetric('done', {
      request_id: requestId,
      scope,
      task_id: taskId,
      started_at: isoNow(startedAtMs),
      first_token_at: firstTokenAtMs ? isoNow(firstTokenAtMs) : null,
      finished_at: isoNow(finishedAtMs),
      first_token_ms: firstTokenAtMs ? firstTokenAtMs - startedAtMs : null,
      total_ms: finishedAtMs - startedAtMs,
      chunk_count: chunkCount,
      done_reason: reason,
      ...extra,
    });
  }

  logChatMetric('started', {
    request_id: requestId,
    scope,
    task_id: taskId,
    started_at: isoNow(startedAtMs),
    cwd,
    prompt_len: String(message || '').length,
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(`data: ${JSON.stringify({ ready: true })}\n\n`);

  const nvmNode = path.join(process.env.HOME || '/root', '.nvm/versions/node/v22.22.0/bin');
  const env = { ...process.env, PATH: `${nvmNode}:${process.env.PATH}` };
  if (!env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = 'https://crs.itssx.com/api';

  const args = ['--print', '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];
  const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  if (onProcess) onProcess(child);
  child.stdin.write(`${message}\n`);
  child.stdin.end();

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  child.stdout.on('data', (chunk) => {
    if (!firstTokenAtMs) {
      firstTokenAtMs = Date.now();
      logChatMetric('first_token', {
        request_id: requestId,
        scope,
        task_id: taskId,
        started_at: isoNow(startedAtMs),
        first_token_at: isoNow(firstTokenAtMs),
        first_token_ms: firstTokenAtMs - startedAtMs,
      });
    }
    chunkCount += 1;
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ text: chunk.toString() })}\n\n`);
  });

  child.stderr.on('data', (chunk) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ text: chunk.toString(), stderr: true })}\n\n`);
  });

  child.on('error', (err) => {
    clearInterval(heartbeat);
    finalize('process_error', { error: err.message, exit_code: null });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: true, text: err.message, done: true })}\n\n`);
      res.end();
    }
  });

  child.on('close', (code, signal) => {
    clearInterval(heartbeat);
    finalize(signal ? 'signal_exit' : 'process_exit', { exit_code: code, exit_signal: signal || null });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true, code, signal })}\n\n`);
      res.end();
    }
  });

  const timeout = setTimeout(() => {
    finalize('timeout', { exit_code: null });
    if (!child.killed) child.kill('SIGTERM');
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: true, text: '[Timeout after 5 minutes]', done: true })}\n\n`);
      res.end();
    }
  }, 300000);

  res.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    if (!doneLogged) {
      finalize('client_disconnect', { exit_code: null });
    }
    if (!child.killed) child.kill('SIGTERM');
  });

  return child;
}

// Agent chat - powered by Claude Code (SSE streaming)
let activeAgentProcess = null;

app.post('/api/agent', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  if (activeAgentProcess) {
    try { activeAgentProcess.kill('SIGTERM'); } catch {}
    activeAgentProcess = null;
  }

  const cwd = path.join(__dirname, '..');
  startClaudeStream(
    {
      cwd,
      message,
      scope: 'agent',
      onProcess: (child) => {
        activeAgentProcess = child;
        child.on('close', () => { activeAgentProcess = null; });
      },
    },
    res
  );
});

const activeTaskAgents = new Map();
app.post('/api/tasks/:id/chat', (req, res) => {
  const { id } = req.params;
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const task = db.getTask(id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  let cwd = task.worktree_path;
  if (!cwd && task.project_id) {
    cwd = db.getProject(task.project_id)?.repo_path;
  }
  if (!cwd) return res.status(400).json({ error: 'task worktree/repo path missing' });
  const project = task.project_id ? db.getProject(task.project_id) : null;
  const scopedMessage = buildTaskScopedPrompt(task, project, message, history);

  const prev = activeTaskAgents.get(id);
  if (prev) {
    try { prev.kill('SIGTERM'); } catch {}
    activeTaskAgents.delete(id);
  }

  startClaudeStream(
    {
      cwd,
      message: scopedMessage,
      scope: 'task_chat',
      taskId: id,
      onProcess: (child) => {
        activeTaskAgents.set(id, child);
        child.on('close', () => {
          if (activeTaskAgents.get(id) === child) activeTaskAgents.delete(id);
        });
      },
    },
    res
  );
});

// For terminal/tmux chat stream, keep backward compatibility path.
app.post('/api/tasks/:id/stop-chat', (req, res) => {
  const { id } = req.params;
  const proc = activeTaskAgents.get(id);
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    activeTaskAgents.delete(id);
  }
  res.json({ ok: true });
});

// Self-deploy: git pull + build + restart
const ROOT_DIR = path.join(__dirname, '..');
let deploying = false;

function selfDeploy() {
  if (deploying) return Promise.resolve('already deploying');
  deploying = true;
  return new Promise((resolve, reject) => {
    const nvm = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 22 2>/dev/null;';
    const cmd = `${nvm} cd ${ROOT_DIR} && git checkout -- . && git pull origin main && npm install && cd client && npm install && npm run build && cd .. && npm rebuild`;
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      deploying = false;
      if (err) return reject(err);
      setTimeout(() => {
        exec('pm2 restart claude-manager', () => {});
      }, 500);
      resolve(stdout);
    });
  });
}

app.post('/api/deploy', async (req, res) => {
  try {
    const out = await selfDeploy();
    res.json({ ok: true, output: out.slice(-500) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/webhook/github', async (req, res) => {
  const event = req.headers['x-github-event'];
  if (event !== 'push') return res.json({ ignored: true });
  const branch = req.body?.ref;
  if (branch !== 'refs/heads/main') return res.json({ ignored: true, branch });
  res.json({ ok: true, deploying: true });
  try { await selfDeploy(); } catch (e) { console.error('Webhook deploy failed:', e.message); }
});

// Recovery
function recoverSessions() {
  const aliveSessions = ptyManager.listAliveSessions();
  const tasks = db.getTasks();
  for (const task of tasks) {
    if (task.status === 'in_progress' && task.tmux_session) {
      if (aliveSessions.includes(task.tmux_session)) {
        ptyManager.attachSession(task.tmux_session);
        if (task.worktree_path) watchProgress(task.worktree_path, task.id);
        console.log(`Recovered session: ${task.tmux_session}`);
      } else {
        db.updateTask(task.id, { status: 'interrupted' });
        console.log(`Session dead, marked interrupted: ${task.tmux_session}`);
      }
    }
  }
}

// WebSocket
io.on('connection', (socket) => {
  let currentSession = null;

  socket.on('terminal:attach', (sessionName) => {
    currentSession = sessionName;
    const entry = ptyManager.sessions.get(sessionName);
    if (!entry) return socket.emit('terminal:error', 'Session not found');
    entry.clients.add(socket);
    entry.ptyProcess.onData((data) => socket.emit('terminal:data', data));
  });

  socket.on('terminal:input', (data) => {
    if (currentSession) ptyManager.sendInput(currentSession, data);
  });

  socket.on('disconnect', () => {
    if (currentSession) {
      const entry = ptyManager.sessions.get(currentSession);
      if (entry) entry.clients.delete(socket);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Claude Code Manager running on http://localhost:${PORT}`);
  recoverSessions();
});

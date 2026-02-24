require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');
const { execSync, exec, spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const db = require('./db');
const { syncTaskToNotion } = require('./notion-sync');
const ptyManager = require('./pty-manager');
const { TaskChatRuntimeManager } = require('./task-chat-runtime');
const { watchProgress, unwatchProgress } = require('./file-watcher');

const WORKFLOW_DIR = process.env.WORKFLOW_DIR || path.join(process.env.HOME, 'Documents/claude-workflow');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const taskChatRuntimeManager = new TaskChatRuntimeManager({
  logMetric: (event, payload) => logChatMetric(event, payload),
});

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

app.put('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.getProject(id);
  if (!existing) return res.status(404).json({ error: 'project not found' });
  const updated = db.updateProject(id, req.body);
  res.json(updated);
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
  const safeTaskId = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'task';
  const sessionName = `claude-task-${safeTaskId}`;

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

  let tmuxAvailable = true;
  try {
    const existed = ptyManager.sessionExists(sessionName);
    ptyManager.ensureSession(sessionName, worktreePath);
    if (!existed) {
      setTimeout(() => {
        try {
          if (mode === 'ralph') {
            ptyManager.sendInput(sessionName, './ralph.sh --tool claude\n');
          } else {
            ptyManager.sendInput(sessionName, `claude --model ${model || 'claude-sonnet-4-5'} --dangerously-skip-permissions\n`);
            // Auto-accept the --dangerously-skip-permissions confirmation dialog
            setTimeout(() => { try { ptyManager.sendInput(sessionName, '\n'); } catch {} }, 3000);
          }
        } catch (err) {
          console.warn(`tmux sendInput failed for task ${id}:`, err?.message || err);
        }
      }, 500);
    }
  } catch (err) {
    tmuxAvailable = false;
    console.warn(`tmux unavailable for task ${id}:`, err?.message || err);
  }

  watchProgress(worktreePath, id);
  res.json({ sessionName, tmuxCmd: ptyManager.getTmuxAttachCmd(sessionName), tmuxAvailable });
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const { id } = req.params;
  const task = db.getTask(id);
  taskChatRuntimeManager.stopTask(id, 'task_stop');
  if (task?.tmux_session) ptyManager.killSession(task.tmux_session);
  if (task?.worktree_path) unwatchProgress(task.worktree_path);
  const updated = db.updateTask(id, { status: 'done' });
  syncTaskToNotion(updated);
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const projectTasks = db.getTasks(id);
  for (const t of projectTasks) {
    taskChatRuntimeManager.stopTask(t.id, 'project_delete');
  }
  const ok = db.deleteProject(id);
  if (!ok) return res.status(404).json({ error: 'project not found' });
  res.json({ ok: true, deleted: id });
});

app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const task = db.getTask(id);
  taskChatRuntimeManager.stopTask(id, 'task_delete');
  if (task?.tmux_session) ptyManager.killSession(task.tmux_session);
  if (task?.worktree_path) unwatchProgress(task.worktree_path);
  const ok = db.deleteTask(id);
  if (!ok) return res.status(404).json({ error: 'task not found' });
  res.json({ ok: true, deleted: id });
});

app.get('/api/tasks/:id/chat/history', (req, res) => {
  const { id } = req.params;
  const task = db.getTask(id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json({ messages: db.getTaskChatMessages(id, 300) });
});

app.delete('/api/tasks/:id/chat/history', (req, res) => {
  const { id } = req.params;
  const task = db.getTask(id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  taskChatRuntimeManager.stopTask(id, 'clear_history');
  db.clearTaskChatMessages(id);
  db.updateTask(id, { chatSessionId: null });
  res.json({ ok: true });
});

function logChatMetric(event, payload) {
  console.log(`[chat-metric] ${JSON.stringify({ event, ...payload })}`);
}

function ensureTaskProcess(task, opts = {}) {
  const { ensureTmux = true } = opts;
  if (!task) return null;
  const safeTaskId = String(task.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'task';
  const sessionName = task.tmux_session || `claude-task-${safeTaskId}`;
  let cwd = task.worktree_path;
  if (!cwd && task.project_id) {
    cwd = db.getProject(task.project_id)?.repo_path;
  }
  if (!cwd) return null;

  if (ensureTmux) {
    const existed = ptyManager.sessionExists(sessionName);
    try {
      ptyManager.ensureSession(sessionName, cwd || process.env.HOME || '/');
      if (!existed) {
        setTimeout(() => {
          try {
            ptyManager.sendInput(sessionName, 'export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LC_CTYPE=en_US.UTF-8\n');
            if (task.mode === 'ralph') ptyManager.sendInput(sessionName, './ralph.sh --tool claude\n');
            else {
              ptyManager.sendInput(sessionName, `claude --model ${task.model || 'claude-sonnet-4-5'} --dangerously-skip-permissions\n`);
              // Auto-accept the --dangerously-skip-permissions confirmation dialog
              setTimeout(() => { try { ptyManager.sendInput(sessionName, '\n'); } catch {} }, 3000);
            }
          } catch (err) {
            console.warn(`tmux sendInput failed for task ${task.id}:`, err?.message || err);
          }
        }, 500);
      }
    } catch (err) {
      console.warn(`tmux ensureSession failed for task ${task.id}:`, err?.message || err);
    }
  }
  if (task.tmux_session !== sessionName || task.status !== 'in_progress') {
    const updated = db.updateTask(task.id, { tmuxSession: sessionName, status: 'in_progress' });
    syncTaskToNotion(updated);
  }
  if (cwd) watchProgress(cwd, task.id);
  return { sessionName, cwd };
}

function isoNow(ts = Date.now()) {
  return new Date(ts).toISOString();
}

const TASK_CHAT_HISTORY_LIMIT = 24;
const TASK_CHAT_HISTORY_TEXT_LIMIT = 120;

function compactText(input, maxLen = TASK_CHAT_HISTORY_TEXT_LIMIT) {
  const oneLine = String(input || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}...`;
}

function shouldIncludeHistoryEntry(entry) {
  const role = entry?.role;
  const text = String(entry?.text || '').trim();
  if (!text) return false;
  if (role !== 'user' && role !== 'assistant') return false;
  if (text.includes('You are in Task Session Chat. Strict scope rules:')) return false;
  if (text.includes('────────────────────────────────')) return false;
  return true;
}

function buildTaskScopedPrompt(task, project, userMessage, history = []) {
  const normalizedHistory = Array.isArray(history)
    ? history
      .filter((entry) => shouldIncludeHistoryEntry(entry))
      .slice(-TASK_CHAT_HISTORY_LIMIT)
      .map((entry) => ({
        role: entry.role === 'assistant' ? 'assistant' : 'user',
        text: compactText(entry.text),
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
    compactText(userMessage, 600),
  ];
  return lines.join('\n');
}

function buildTaskSessionPrompt(task, project, userMessage, bootstrap = false) {
  const lines = [];
  if (bootstrap) {
    lines.push(
      'You are in Task Session Chat. Strict scope rules:',
      '1) Only discuss and act on the current task shown below.',
      '2) Do NOT query/list/summarize other tasks unless explicitly requested.',
      '3) Keep answers concise and action-oriented.',
      '',
      'Current task context:',
      `- task_id: ${task?.id || ''}`,
      `- title: ${task?.title || ''}`,
      `- status: ${task?.status || ''}`,
      `- branch: ${task?.branch || ''}`,
      `- project_name: ${project?.name || ''}`,
      '',
    );
  } else {
    lines.push(
      `Task scope reminder: task_id=${task?.id || ''}, title="${task?.title || ''}", branch="${task?.branch || ''}", project="${project?.name || ''}".`,
      'Continue in the same task-scoped conversation context.',
      '',
    );
  }
  lines.push('Current user message:', compactText(userMessage, 1200));
  return lines.join('\n');
}

function isTaskStatusQuery(message) {
  const text = String(message || '').toLowerCase().trim();
  if (!text) return false;
  const patterns = [
    /进度/,
    /状态/,
    /什么进展/,
    /目前.*(怎么样|如何|进度)/,
    /还要多久/,
    /现在.*(干嘛|做什么)/,
    /\bprogress\b/,
    /\bstatus\b/,
    /\bupdate\b/,
    /\bwhat('?s| is)?\s+the\s+progress\b/,
  ];
  return patterns.some((re) => re.test(text));
}

function buildTaskStatusReply(task, project, hasActiveProcess) {
  const status = task?.status || 'unknown';
  const title = task?.title || '(untitled)';
  const branch = task?.branch || '(none)';
  const updatedAt = task?.updated_at || task?.created_at || '(unknown)';
  const projectName = project?.name || '(unknown)';
  const running = hasActiveProcess ? 'yes' : 'no';
  return [
    'Current task progress summary:',
    `- title: ${title}`,
    `- status: ${status}`,
    `- running process attached: ${running}`,
    `- branch: ${branch}`,
    `- project: ${projectName}`,
    `- last updated: ${updatedAt}`,
    '',
    'If you want, I can continue with a concrete next action (for example: integrate ChatWindow, run build, or deploy).',
  ].join('\n');
}

function startClaudeStream({ cwd, message, onProcess, scope, taskId = null, sessionId = null, resumeSession = false }, res) {
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

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(`data: ${JSON.stringify({ ready: true })}\n\n`);

  const nvmNode = path.join(process.env.HOME || '/root', '.nvm/versions/node/v22.22.0/bin');
  const env = { ...process.env, PATH: `${nvmNode}:${process.env.PATH}` };
  if (!env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = 'https://crs.itssx.com/api';

  const args = ['--print', '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];
  if (sessionId) {
    if (resumeSession) args.push('--resume', sessionId);
    else args.push('--session-id', sessionId);
  }
  const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  if (onProcess) onProcess(child);
  child.stdin.write(`${message}\n`);
  child.stdin.end();
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let decodersFlushed = false;

  function emitStreamText(text, extra = {}) {
    if (!text || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ text, ...extra })}\n\n`);
  }

  function flushDecoderTails() {
    if (decodersFlushed) return;
    decodersFlushed = true;
    emitStreamText(stdoutDecoder.end());
    emitStreamText(stderrDecoder.end(), { stderr: true });
  }

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
    emitStreamText(stdoutDecoder.write(chunk));
  });

  child.stderr.on('data', (chunk) => {
    emitStreamText(stderrDecoder.write(chunk), { stderr: true });
  });

  child.on('error', (err) => {
    flushDecoderTails();
    clearInterval(heartbeat);
    finalize('process_error', { error: err.message, exit_code: null });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({
        error: true,
        error_code: 'PROCESS_ERROR',
        text: `agent process error: ${err.message}`,
        done: true,
      })}\n\n`);
      res.end();
    }
  });

  child.on('close', (code, signal) => {
    flushDecoderTails();
    clearInterval(heartbeat);
    finalize(signal ? 'signal_exit' : 'process_exit', { exit_code: code, exit_signal: signal || null });
    if (!res.writableEnded) {
      const isAbnormal = Boolean(signal) || (typeof code === 'number' && code !== 0);
      if (isAbnormal) {
        res.write(`data: ${JSON.stringify({
          error: true,
          error_code: 'PROCESS_EXIT',
          text: `agent exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          done: true,
          code,
          signal,
        })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ done: true, code, signal })}\n\n`);
      }
      res.end();
    }
  });

  const timeout = setTimeout(() => {
    finalize('timeout', { exit_code: null });
    if (!child.killed) child.kill('SIGTERM');
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({
        error: true,
        error_code: 'TIMEOUT',
        text: 'agent timeout after 5 minutes',
        done: true,
      })}\n\n`);
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

app.post('/api/tasks/:id/chat', (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const task = db.getTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const runtime = ensureTaskProcess(task, { ensureTmux: false });
    if (!runtime) return res.status(400).json({ error: 'task worktree/repo path missing' });

    const project = task.project_id ? db.getProject(task.project_id) : null;
    if (isTaskStatusQuery(message)) {
      const quickReply = buildTaskStatusReply(task, project, ptyManager.sessionExists(runtime.sessionName));
      db.appendTaskChatMessage(id, 'user', message);
      db.appendTaskChatMessage(id, 'assistant', quickReply);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      res.write(`data: ${JSON.stringify({ ready: true })}\n\n`);
      res.write(`data: ${JSON.stringify({ text: quickReply })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, code: 0, signal: null, shortcut: 'task_status' })}\n\n`);
      res.end();
      return;
    }

    const hasSession = Boolean(task.chat_session_id);
    const chatSessionId = task.chat_session_id || randomUUID();
    if (!hasSession) db.updateTask(id, { chatSessionId });
    db.appendTaskChatMessage(id, 'user', message);
    const scopedMessage = buildTaskSessionPrompt(task, project, message, !hasSession);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`data: ${JSON.stringify({ ready: true })}\n\n`);

    let clientClosed = false;
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    const cleanup = () => clearInterval(heartbeat);
    res.on('close', () => {
      clientClosed = true;
      cleanup();
    });

    taskChatRuntimeManager.send({
      taskId: id,
      cwd: runtime.cwd || path.join(__dirname, '..'),
      sessionId: chatSessionId,
      resumeSession: hasSession,
      prompt: scopedMessage,
      timeoutMs: 300000,
      onAssistantText: (text) => {
        if (clientClosed || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      },
    }).then((assistantOutput) => {
      cleanup();
      if (assistantOutput.trim()) db.appendTaskChatMessage(id, 'assistant', assistantOutput);
      if (!clientClosed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true, code: 0, signal: null })}\n\n`);
        res.end();
      }
    }).catch((err) => {
      cleanup();
      if (res.writableEnded || clientClosed) return;
      res.write(`data: ${JSON.stringify({
        error: true,
        error_code: 'TASK_CHAT_RUNTIME_ERROR',
        text: err?.message || 'task chat runtime error',
        done: true,
      })}\n\n`);
      res.end();
    });
    return;
  } catch (err) {
    if (res.writableEnded) return;
    res.status(500).json({ error: err?.message || 'task chat failed' });
  }
});

// For terminal/tmux chat stream, keep backward compatibility path.
app.post('/api/tasks/:id/stop-chat', (req, res) => {
  // keep task runtime alive until task is done/deleted; closing chat modal should not stop it.
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
    const cmd = `${nvm} cd ${ROOT_DIR} && git fetch origin && git checkout main && git reset --hard origin/main && git clean -fd && npm install && npm install node-pty@1.0.0 --save-exact --build-from-source && cd client && npm install && npm run build && cd ..`;
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

  function detachFromCurrentSession() {
    if (!currentSession) return;
    const prev = ptyManager.sessions.get(currentSession);
    if (prev) prev.clients.delete(socket);
    currentSession = null;
  }

  socket.on('terminal:attach', (payload) => {
    // Support legacy string and new object form {sessionName, cols, rows}
    const sessionName = typeof payload === 'string' ? payload : payload?.sessionName;
    const initCols = typeof payload === 'object' && payload?.cols > 0 ? payload.cols : null;
    const initRows = typeof payload === 'object' && payload?.rows > 0 ? payload.rows : null;

    detachFromCurrentSession();
    currentSession = sessionName;
    let entry = ptyManager.sessions.get(sessionName);
    if (!entry && ptyManager.sessionExists(sessionName)) {
      try { entry = ptyManager.attachSession(sessionName); } catch {}
    }
    if (!entry) return socket.emit('terminal:error', 'Session not found');
    entry.clients.add(socket);
    const replay = ptyManager.getBufferedOutput(sessionName);
    if (replay) socket.emit('terminal:data', replay);

    // If client sent its dimensions, resize PTY to match BEFORE SIGWINCH so tmux
    // redraws at the correct size (prevents status-bar row mismatch and missing content).
    if (initCols && initRows) {
      ptyManager.resizeSession(sessionName, initCols, initRows);
    }

    // Force SIGWINCH by toggling size — triggers a full redraw from the terminal app.
    const { cols, rows } = entry.ptyProcess;
    if (cols > 1 && rows > 1) {
      // Keep tmux internal size in sync while triggering SIGWINCH.
      ptyManager.resizeSession(sessionName, cols - 1, rows);
      setTimeout(() => ptyManager.resizeSession(sessionName, cols, rows), 50);
    }
  });

  socket.on('terminal:input', (data) => {
    if (currentSession) ptyManager.sendInput(currentSession, data);
  });

  socket.on('terminal:resize', ({ cols, rows }) => {
    if (currentSession && cols > 0 && rows > 0) {
      ptyManager.resizeSession(currentSession, cols, rows);
    }
  });

  socket.on('disconnect', () => {
    detachFromCurrentSession();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Claude Code Manager running on http://localhost:${PORT}`);
  recoverSessions();
});

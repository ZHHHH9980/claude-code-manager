require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { execSync, exec, spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const db = require('./db');
const { syncProjectToNotion, syncTaskToNotion } = require('./notion-sync');
const ptyManager = require('./pty-manager');
const { TaskChatRuntimeManager } = require('./task-chat-runtime');
const { buildClaudeEnv } = require('./claude-env');
const {
  normalizeAdapterModel,
  isCommandAvailable,
  buildProjectContextEnvExports,
  launchAdapterInSession,
} = require('./adapter-launch');
const { resolveTaskWorkingDirectory, syncProjectInstructionFiles } = require('./project-context');
const {
  buildTaskScopedPrompt,
  buildTaskSessionPrompt,
  isTaskStatusQuery,
  buildTaskStatusReply,
} = require('./task-chat-helpers');
const { createTaskProcessService } = require('./task-process');
const { registerTerminalHttpRoutes } = require('./terminal-http-routes');
const { normalizeSessionName } = require('./terminal-http-helpers');
const { watchProgress, unwatchProgress } = require('./file-watcher');
const { resolveAdapter, listAdapters } = require('./adapters');

const WORKFLOW_DIR = process.env.WORKFLOW_DIR || path.join(process.env.HOME, 'Documents/claude-workflow');
const SESSIONS_DIR = path.join(__dirname, '../data/sessions');
const DEFAULT_FRONTEND_ORIGINS = new Set(['http://localhost:8080', 'http://127.0.0.1:8080']);
const MODEL_ALIASES = {
  codex: {
    'gpt-5.3-codex': 'gpt-5.4',
  },
};

function parseFrontendOrigins(input) {
  return String(input || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const configuredFrontendOrigins = parseFrontendOrigins(process.env.FRONTEND_URL);
const allowAnyOrigin = configuredFrontendOrigins.length === 0
  || (configuredFrontendOrigins.length === 1 && DEFAULT_FRONTEND_ORIGINS.has(configuredFrontendOrigins[0]));
const allowedOriginSet = new Set(configuredFrontendOrigins);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowAnyOrigin) return true;
  return allowedOriginSet.has(origin);
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    console.warn(`[cors] blocked origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      return callback(null, isAllowedOrigin(origin));
    },
    credentials: true,
  },
});
const taskChatRuntimeManager = new TaskChatRuntimeManager({
  logMetric: (event, payload) => logChatMetric(event, payload),
});
const taskProcessService = createTaskProcessService({
  db,
  fs,
  ptyManager,
  watchProgress,
  syncTaskToNotion,
  resolveAdapter,
  resolveTaskWorkingDirectory,
  syncProjectInstructionFiles,
  normalizeAdapterModel,
  buildProjectContextEnvExports,
  launchAdapterInSession,
  isCommandAvailable,
  modelAliases: MODEL_ALIASES,
  workflowDir: WORKFLOW_DIR,
  sessionsDir: SESSIONS_DIR,
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

function isValidAccessToken(req, expectedToken) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ') && auth.slice(7).trim() === expectedToken) {
    return true;
  }
  const queryToken = typeof req.query?.access_token === 'string' ? req.query.access_token.trim() : '';
  return queryToken.length > 0 && queryToken === expectedToken;
}

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/api/webhook/github') return next();
  const token = process.env.ACCESS_TOKEN;
  if (!token) return next();
  if (isValidAccessToken(req, token)) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// Static files are now served by static-server.js
// app.use(express.static(path.join(__dirname, '../client/dist')));

// Projects
app.get('/api/projects', (req, res) => {
  res.json(db.getProjects());
});

app.get('/api/adapters', (req, res) => {
  const payload = listAdapters().map((adapter) => ({
    name: adapter.name,
    label: adapter.label,
    color: adapter.color,
    models: Array.isArray(adapter.models) ? adapter.models : [],
    defaultModel: adapter.defaultModel || null,
    supportsChatMode: Boolean(adapter.chatMode),
  }));
  res.json(payload);
});

app.post('/api/projects', (req, res) => {
  const project = db.createProject(req.body);
  syncProjectToNotion(project);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.getProject(id);
  if (!existing) return res.status(404).json({ error: 'project not found' });
  const updated = db.updateProject(id, req.body);
  syncProjectToNotion(updated);
  res.json(updated);
});

// Tasks
app.get('/api/tasks', (req, res) => {
  const { projectId } = req.query;
  res.json(db.getTasks(projectId));
});

app.post('/api/tasks', (req, res) => {
  const allAdapters = listAdapters();
  const defaultAdapter = allAdapters[0] || { name: 'claude', defaultModel: 'claude-sonnet-4-5' };
  const task = db.createTask({
    ...req.body,
    mode: req.body.mode || defaultAdapter.name,
    model: normalizeAdapterModel(defaultAdapter, req.body.model || defaultAdapter.defaultModel),
  });
  syncTaskToNotion(task);
  res.json(task);
});

app.post('/api/tasks/:id/start', (req, res) => {
  const { id } = req.params;
  const { worktreePath, branch, model, mode } = req.body;
  const result = taskProcessService.startTaskSession(id, {
    requestedPath: worktreePath,
    branch,
    model,
    mode,
  });
  if (result.httpStatus) {
    return res.status(result.httpStatus).json(result.body);
  }
  res.json(result.body);
});

app.post('/api/tasks/:id/stop', (req, res) => {
  const { id } = req.params;
  const task = db.getTask(id);
  taskChatRuntimeManager.stopTask(id, 'task_stop');
  if (task?.pty_session) ptyManager.killSession(task.pty_session);
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
  if (task?.pty_session) ptyManager.killSession(task.pty_session);
  if (task?.worktree_path) unwatchProgress(task.worktree_path);
  const ok = db.deleteTask(id);
  if (!ok) return res.status(404).json({ error: 'task not found' });
  res.json({ ok: true, deleted: id });
});

registerTerminalHttpRoutes({
  app,
  db,
  ptyManager,
  ensureTaskProcess,
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
  return taskProcessService.ensureTaskProcess(task, opts);
}

function isoNow(ts = Date.now()) {
  return new Date(ts).toISOString();
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

  const env = buildClaudeEnv();

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

// Agent chat - keep one hot runtime like task chat to avoid cold-start each turn.
const AGENT_RUNTIME_KEY = '__agent_home__';
let agentChatSessionId = db.getAgentSessionId(); // Restore from database on startup

function resetAgentChat(reason = 'agent_reset') {
  taskChatRuntimeManager.stopTask(AGENT_RUNTIME_KEY, reason);
  agentChatSessionId = null;
  db.setAgentSessionId(null); // Clear persisted session ID
}

const AGENT_TERMINAL_SESSION = process.env.AGENT_TERMINAL_SESSION || 'claude-agent-home';

function startAgentTerminalSession(mode = 'claude') {
  const resolved = resolveAdapter(mode);
  const adapter = resolved.adapter;
  if (resolved.usedLegacyAlias) {
    console.warn(`[adapter] legacy mode "${resolved.requestedName}" requested for agent terminal, fallback to "${resolved.resolvedName}"`);
  }

  if (!isCommandAvailable(adapter.cli)) {
    return {
      sessionName: AGENT_TERMINAL_SESSION,
      ptyOk: false,
      mode: adapter.name,
      error: `CLI not found: ${adapter.cli}`,
    };
  }

  const cwd = path.join(__dirname, '..');
  let ptyOk = true;
  let error = null;
  try {
    const existed = ptyManager.sessionExists(AGENT_TERMINAL_SESSION);
    ptyManager.ensureSession(AGENT_TERMINAL_SESSION, cwd);
    if (!existed) {
      setTimeout(() => {
        try {
          launchAdapterInSession(
            AGENT_TERMINAL_SESSION,
            { adapter, model: adapter.defaultModel, context: 'agent terminal' },
            { ptyManager, aliases: MODEL_ALIASES },
          );
        } catch (err) {
          ptyOk = false;
          error = err?.message || String(err);
          console.warn('agent terminal sendInput failed:', err?.message || err);
        }
      }, 500);
    }
  } catch (err) {
    ptyOk = false;
    error = err?.message || String(err);
    console.warn('agent terminal unavailable:', err?.message || err);
  }
  return {
    sessionName: AGENT_TERMINAL_SESSION,
    ptyOk,
    mode: adapter.name,
    error,
  };
}

app.get('/api/agent/history', (req, res) => {
  res.json({ messages: db.getAgentChatMessages(400) });
});

app.delete('/api/agent/history', (req, res) => {
  resetAgentChat('agent_clear_history');
  db.clearAgentChatMessages();
  res.json({ ok: true });
});

app.post('/api/agent/terminal/start', (req, res) => {
  const payload = startAgentTerminalSession(req.body?.mode);
  res.json(payload);
});

app.post('/api/agent/terminal/stop', (req, res) => {
  try { ptyManager.killSession(AGENT_TERMINAL_SESSION); } catch {}
  res.json({ ok: true });
});

app.post('/api/agent', (req, res) => {
  try {
    const prompt = String(req.body?.message || '').trim();
    if (!prompt) return res.status(400).json({ error: 'message required' });

    const hasSession = Boolean(agentChatSessionId);
    const sessionId = agentChatSessionId || randomUUID();
    if (!hasSession) {
      agentChatSessionId = sessionId;
      db.setAgentSessionId(sessionId); // Persist to database
    }
    db.appendAgentChatMessage('user', prompt);

    const cwd = path.join(__dirname, '..');
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

    let assistantText = '';
    taskChatRuntimeManager.send({
      taskId: AGENT_RUNTIME_KEY,
      cwd,
      sessionId,
      resumeSession: hasSession,
      prompt,
      timeoutMs: 300000,
      onAssistantText: (text) => {
        if (clientClosed || res.writableEnded) return;
        assistantText += String(text || '');
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      },
    }).then(() => {
      cleanup();
      if (assistantText.trim()) db.appendAgentChatMessage('assistant', assistantText);
      if (!clientClosed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true, code: 0, signal: null })}\n\n`);
        res.end();
      }
    }).catch((err) => {
      cleanup();
      taskChatRuntimeManager.stopTask(AGENT_RUNTIME_KEY, 'agent_runtime_error');
      const msg = String(err?.message || 'agent chat runtime error');
      if (/not logged in|authentication_failed|session .* not found|invalid session/i.test(msg)) {
        agentChatSessionId = null;
        db.setAgentSessionId(null); // Clear persisted session ID
      }
      if (res.writableEnded || clientClosed) return;
      res.write(`data: ${JSON.stringify({
        error: true,
        error_code: 'AGENT_RUNTIME_ERROR',
        text: msg,
        done: true,
      })}\n\n`);
      res.end();
    });
  } catch (err) {
    if (res.writableEnded) return;
    res.status(500).json({ error: err?.message || 'agent chat failed' });
  }
});

app.post('/api/tasks/:id/chat', (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const task = db.getTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const runtime = ensureTaskProcess(task, { ensurePty: false });
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

// For terminal chat stream, keep backward compatibility path.
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
        // Restart both API and static servers
        exec('pm2 restart claude-manager-api', () => {});
        exec('pm2 restart claude-manager-static', () => {});
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
  taskProcessService.recoverSessions();
}

// WebSocket
io.on('connection', (socket) => {
  // Track all sessions this socket is attached to (one socket can serve multiple Terminal components)
  const attachedSessions = new Set();

  function emitSocketTerminalError(sessionName, code, message, recoverable = false) {
    socket.emit('terminal:error', message);
    socket.emit('terminal:error:v2', {
      sessionName: sessionName || null,
      code,
      message,
      recoverable,
    });
  }

  socket.on('terminal:attach', (payload) => {
    // Support legacy string and new object form {sessionName, cols, rows}
    const requestedSessionName = typeof payload === 'string' ? payload : payload?.sessionName;
    const sessionName = normalizeSessionName(requestedSessionName);
    const initCols = typeof payload === 'object' && payload?.cols > 0 ? payload.cols : null;
    const initRows = typeof payload === 'object' && payload?.rows > 0 ? payload.rows : null;
    const replayBuffer = typeof payload === 'object' && typeof payload?.replayBuffer === 'boolean'
      ? payload.replayBuffer
      : true;
    const forceRedraw = typeof payload === 'object' && typeof payload?.forceRedraw === 'boolean'
      ? payload.forceRedraw
      : true;
    if (!sessionName) {
      emitSocketTerminalError(requestedSessionName, 'invalid_session_name', 'Invalid session name', false);
      return;
    }

    let entry = ptyManager.sessions.get(sessionName);
    if (!entry && ptyManager.sessionExists(sessionName)) {
      try { entry = ptyManager.attachSession(sessionName); } catch {}
    }
    if (!entry) {
      emitSocketTerminalError(sessionName, 'session_not_found', 'Session not found', false);
      return;
    }

    attachedSessions.add(sessionName);
    entry.clients.add(socket);
    let replayBytes = 0;

    // Replay session buffer on attach so reconnect/new tab can see recent output.
    if (replayBuffer) {
      const buffered = ptyManager.getBufferedOutput
        ? ptyManager.getBufferedOutput(sessionName)
        : '';
      if (buffered) {
        replayBytes = buffered.length;
        socket.emit(`terminal:data:${sessionName}`, buffered);
      }
    }

    // If client sent its dimensions, resize PTY to match BEFORE SIGWINCH so the
    // terminal app redraws at the correct size.
    if (initCols && initRows) {
      ptyManager.resizeSession(sessionName, initCols, initRows);
    }

    // Optional SIGWINCH toggle. Some CLIs (Codex) can duplicate prompt blocks on
    // forced redraw, so client can disable this per attach.
    if (forceRedraw) {
      const { cols, rows } = entry.ptyProcess;
      if (cols > 1 && rows > 1) {
        entry.ptyProcess.resize(cols - 1, rows);
        setTimeout(() => entry.ptyProcess.resize(cols, rows), 50);
      }
    }
    socket.emit('terminal:ready', {
      sessionName,
      replayed: replayBytes > 0,
      replayBytes,
      cols: entry.ptyProcess.cols,
      rows: entry.ptyProcess.rows,
    });
  });

  socket.on('terminal:input', ({ sessionName: sn, data }) => {
    const sessionName = normalizeSessionName(sn);
    if (!sessionName) {
      emitSocketTerminalError(sn, 'invalid_session_name', 'Invalid session name', false);
      return;
    }
    if (!ptyManager.sessionExists(sessionName)) {
      emitSocketTerminalError(sessionName, 'session_not_found', 'Session not found', false);
      return;
    }
    if (typeof data !== 'string' || data.length === 0) {
      emitSocketTerminalError(sessionName, 'input_required', 'Input data required', true);
      return;
    }
    ptyManager.sendInput(sessionName, data);
  });

  socket.on('terminal:resize', ({ sessionName: sn, cols, rows }) => {
    const sessionName = normalizeSessionName(sn);
    if (!sessionName) return;
    if (!ptyManager.sessionExists(sessionName)) {
      emitSocketTerminalError(sessionName, 'session_not_found', 'Session not found', false);
      return;
    }
    if (cols > 0 && rows > 0) {
      ptyManager.resizeSession(sessionName, cols, rows);
    }
  });

  socket.on('disconnect', () => {
    for (const sessionName of attachedSessions) {
      const entry = ptyManager.sessions.get(sessionName);
      if (entry) entry.clients.delete(socket);
    }
    attachedSessions.clear();
  });
});

// Persist PTY buffers to disk on graceful shutdown so recoverSessions() can
// replay history after a server restart.
process.on('SIGTERM', () => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    for (const [sessionName, entry] of ptyManager.sessions) {
      if (entry.outputBuffer) {
        fs.writeFileSync(path.join(SESSIONS_DIR, `${sessionName}.buf`), entry.outputBuffer);
      }
    }
  } catch (err) {
    console.error('Failed to persist session buffers:', err?.message);
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Claude Code Manager running on http://localhost:${PORT}`);
  recoverSessions();
});

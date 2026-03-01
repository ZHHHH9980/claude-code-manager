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
const { syncTaskToNotion } = require('./notion-sync');
const ptyManager = require('./pty-manager');
const { TaskChatRuntimeManager } = require('./task-chat-runtime');
const { watchProgress, unwatchProgress } = require('./file-watcher');
const { resolveAdapter, listAdapters } = require('./adapters');

const WORKFLOW_DIR = process.env.WORKFLOW_DIR || path.join(process.env.HOME, 'Documents/claude-workflow');
const SESSIONS_DIR = path.join(__dirname, '../data/sessions');
const DEFAULT_FRONTEND_ORIGINS = new Set(['http://localhost:8080', 'http://127.0.0.1:8080']);

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

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/api/webhook/github') return next();
  const token = process.env.ACCESS_TOKEN;
  if (!token) return next();
  const auth = req.headers.authorization;
  if (auth === `Bearer ${token}`) return next();
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
  const resolved = resolveAdapter(mode);
  const adapter = resolved.adapter;
  if (resolved.usedLegacyAlias) {
    console.warn(`[adapter] legacy mode "${resolved.requestedName}" requested, fallback to "${resolved.resolvedName}"`);
  }
  const finalModel = model || adapter.defaultModel;
  const safeTaskId = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'task';
  const sessionName = `claude-task-${safeTaskId}`;

  if (!isCommandAvailable(adapter.cli)) {
    return res.status(400).json({
      sessionName,
      ptyOk: false,
      mode: adapter.name,
      model: finalModel,
      error: `CLI not found: ${adapter.cli}`,
    });
  }

  const task = db.updateTask(id, {
    status: 'in_progress',
    worktreePath,
    ptySession: sessionName,
    mode: adapter.name,
    model: finalModel,
  });
  syncTaskToNotion(task);

  // Initialize claude-workflow in worktree
  try {
    execSync(`${WORKFLOW_DIR}/install.sh init`, { cwd: worktreePath, stdio: 'ignore' });
  } catch (e) {
    console.log('Workflow init skipped or already done');
  }

  let ptyOk = true;
  let error = null;
  try {
    const existed = ptyManager.sessionExists(sessionName);
    if (existed) {
      ptyManager.killSession(sessionName);
    }
    ptyManager.ensureSession(sessionName, worktreePath);
    setTimeout(() => {
      try {
        launchAdapterInSession(sessionName, { adapter, model: finalModel, context: `start task ${id}` });
      } catch (err) {
        ptyOk = false;
        error = err?.message || String(err);
        console.warn(`pty sendInput failed for task ${id}:`, err?.message || err);
      }
    }, 500);
  } catch (err) {
    ptyOk = false;
    error = err?.message || String(err);
    console.warn(`pty unavailable for task ${id}:`, err?.message || err);
  }

  watchProgress(worktreePath, id);
  res.json({ sessionName, ptyOk, mode: adapter.name, model: finalModel, error });
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

function isCommandAvailable(cmd) {
  const safe = String(cmd || '').trim();
  if (!safe || !/^[a-zA-Z0-9._-]+$/.test(safe)) return false;
  try {
    execSync(`bash -lc "command -v ${safe}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildAdapterLaunchCommand(adapter, model) {
  const args = [];
  const finalModel = String(model || adapter?.defaultModel || '').trim();
  if (finalModel) args.push('--model', finalModel);
  if (Array.isArray(adapter?.defaultArgs) && adapter.defaultArgs.length > 0) {
    args.push(...adapter.defaultArgs);
  }
  return `${adapter?.cli || 'claude'} ${args.join(' ')}`.trim();
}

function launchAdapterInSession(sessionName, { adapter, model, context }) {
  ptyManager.sendInput(sessionName, 'export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LC_CTYPE=en_US.UTF-8\n');
  ptyManager.sendInput(sessionName, `${buildAdapterLaunchCommand(adapter, model)}\n`);
  if (adapter?.autoConfirm?.enabled) {
    const delayMs = Number(adapter?.autoConfirm?.delayMs) || 3000;
    setTimeout(() => { try { ptyManager.sendInput(sessionName, '\n'); } catch {} }, delayMs);
  }
  if (context) {
    console.log(`launched adapter=${adapter?.name || 'claude'} session=${sessionName} (${context})`);
  }
}

function ensureTaskProcess(task, opts = {}) {
  const { ensurePty = true } = opts;
  if (!task) return null;
  const resolved = resolveAdapter(task.mode);
  const adapter = resolved.adapter;
  if (resolved.usedLegacyAlias) {
    console.warn(`[adapter] legacy mode "${resolved.requestedName}" detected, fallback to "${resolved.resolvedName}"`);
  }
  const safeTaskId = String(task.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'task';
  const sessionName = task.pty_session || `claude-task-${safeTaskId}`;
  const finalModel = task.model || adapter.defaultModel;
  let cwd = task.worktree_path;
  if (!cwd && task.project_id) {
    cwd = db.getProject(task.project_id)?.repo_path;
  }
  if (!cwd) return null;

  if (ensurePty) {
    const existed = ptyManager.sessionExists(sessionName);
    try {
      ptyManager.ensureSession(sessionName, cwd || process.env.HOME || '/');
      if (!existed) {
        setTimeout(() => {
          try {
            if (!isCommandAvailable(adapter.cli)) {
              console.warn(`task ${task.id} launch skipped: CLI not found: ${adapter.cli}`);
              return;
            }
            launchAdapterInSession(sessionName, { adapter, model: finalModel, context: `ensure task ${task.id}` });
          } catch (err) {
            console.warn(`pty sendInput failed for task ${task.id}:`, err?.message || err);
          }
        }, 500);
      }
    } catch (err) {
      console.warn(`pty ensureSession failed for task ${task.id}:`, err?.message || err);
    }
  }
  if (task.pty_session !== sessionName || task.status !== 'in_progress' || task.mode !== adapter.name || task.model !== finalModel) {
    const updated = db.updateTask(task.id, {
      ptySession: sessionName,
      status: 'in_progress',
      mode: adapter.name,
      model: finalModel,
    });
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
    `- pty_session: ${task?.pty_session || ''}`,
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
          launchAdapterInSession(AGENT_TERMINAL_SESSION, { adapter, model: adapter.defaultModel, context: 'agent terminal' });
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
  const aliveSessions = ptyManager.listAliveSessions();
  const tasks = db.getTasks();
  for (const task of tasks) {
    if (task.status === 'in_progress' && task.pty_session) {
      if (aliveSessions.includes(task.pty_session)) {
        ptyManager.attachSession(task.pty_session);
        if (task.worktree_path) watchProgress(task.worktree_path, task.id);
        console.log(`Recovered session: ${task.pty_session}`);
      } else {
        // Load persisted buffer so the terminal can replay history after restart
        const bufFile = path.join(SESSIONS_DIR, `${task.pty_session}.buf`);
        let savedBuffer = '';
        try { savedBuffer = fs.readFileSync(bufFile, 'utf8'); } catch {}

        try {
          const entry = ptyManager.ensureSession(task.pty_session, task.worktree_path);
          if (savedBuffer) {
            entry.outputBuffer = savedBuffer + '\r\n\x1b[33m[session auto-recovered after server restart]\x1b[0m\r\n';
          }
          if (task.worktree_path) watchProgress(task.worktree_path, task.id);

          // Re-launch CC in the new PTY
          setTimeout(() => {
            try {
              const resolved = resolveAdapter(task.mode);
              const adapter = resolved.adapter;
              if (resolved.usedLegacyAlias) {
                console.warn(`[adapter] legacy mode "${resolved.requestedName}" detected during recovery, fallback to "${resolved.resolvedName}"`);
              }
              if (!isCommandAvailable(adapter.cli)) {
                console.warn(`recover task ${task.id} skipped: CLI not found: ${adapter.cli}`);
                return;
              }
              launchAdapterInSession(task.pty_session, { adapter, model: task.model || adapter.defaultModel, context: `recover task ${task.id}` });
            } catch {}
          }, 500);

          console.log(`Auto-restarted session: ${task.pty_session}`);
        } catch (err) {
          db.updateTask(task.id, { status: 'interrupted' });
          console.log(`Failed to restart session, marked interrupted: ${task.pty_session}`);
        }
      }
    }
  }
}

// WebSocket
io.on('connection', (socket) => {
  // Track all sessions this socket is attached to (one socket can serve multiple Terminal components)
  const attachedSessions = new Set();

  socket.on('terminal:attach', (payload) => {
    // Support legacy string and new object form {sessionName, cols, rows}
    const sessionName = typeof payload === 'string' ? payload : payload?.sessionName;
    const initCols = typeof payload === 'object' && payload?.cols > 0 ? payload.cols : null;
    const initRows = typeof payload === 'object' && payload?.rows > 0 ? payload.rows : null;
    const replayBuffer = typeof payload === 'object' && typeof payload?.replayBuffer === 'boolean'
      ? payload.replayBuffer
      : true;

    let entry = ptyManager.sessions.get(sessionName);
    if (!entry && ptyManager.sessionExists(sessionName)) {
      try { entry = ptyManager.attachSession(sessionName); } catch {}
    }
    if (!entry) return socket.emit('terminal:error', 'Session not found');

    attachedSessions.add(sessionName);
    entry.clients.add(socket);

    // Replay session buffer on attach so reconnect/new tab can see recent output.
    if (replayBuffer) {
      const buffered = ptyManager.getBufferedOutput
        ? ptyManager.getBufferedOutput(sessionName)
        : '';
      if (buffered) socket.emit(`terminal:data:${sessionName}`, buffered);
    }

    // If client sent its dimensions, resize PTY to match BEFORE SIGWINCH so the
    // terminal app redraws at the correct size.
    if (initCols && initRows) {
      ptyManager.resizeSession(sessionName, initCols, initRows);
    }

    // Force SIGWINCH by toggling size — triggers a full redraw from the terminal app.
    const { cols, rows } = entry.ptyProcess;
    if (cols > 1 && rows > 1) {
      entry.ptyProcess.resize(cols - 1, rows);
      setTimeout(() => entry.ptyProcess.resize(cols, rows), 50);
    }
  });

  socket.on('terminal:input', ({ sessionName: sn, data }) => {
    if (sn) ptyManager.sendInput(sn, data);
  });

  socket.on('terminal:resize', ({ sessionName: sn, cols, rows }) => {
    if (sn && cols > 0 && rows > 0) {
      ptyManager.resizeSession(sn, cols, rows);
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

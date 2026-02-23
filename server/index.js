require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { execSync, exec } = require('child_process');
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

// Agent chat - powered by Claude Code
app.post('/api/agent', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const cwd = path.join(__dirname, '..');
  const escaped = message.replace(/'/g, "'\\''");
  const cmd = `claude --print --allowedTools Bash Read Edit Write Glob Grep '${escaped}'`;

  const nvmNode = path.join(process.env.HOME || '/root', '.nvm/versions/node/v22.22.0/bin');
  const env = { ...process.env, PATH: `${nvmNode}:${process.env.PATH}` };
  if (!env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = 'https://crs.itssx.com/api';

  exec(cmd, { cwd, timeout: 120000, maxBuffer: 1024 * 1024, env }, (err, stdout, stderr) => {
    if (err) {
      console.error('Agent error:', err.message, stderr);
      return res.json({ text: stderr || err.message, error: true });
    }
    res.json({ text: stdout });
  });
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

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { execSync } = require('child_process');
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

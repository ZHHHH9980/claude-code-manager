require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { execSync } = require('child_process');
const notion = require('./notion');
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

app.get('/api/projects', async (req, res) => {
  res.json(await notion.getProjects());
});

app.get('/api/tasks', async (req, res) => {
  const { projectId } = req.query;
  res.json(await notion.getTasks(projectId));
});

app.post('/api/tasks', async (req, res) => {
  const task = await notion.createTask(req.body);
  res.json(task);
});

app.post('/api/tasks/:id/start', async (req, res) => {
  const { id } = req.params;
  const { worktreePath, branch, model, mode } = req.body;
  const sessionName = `claude-${branch.replace(/\//g, '-')}`;

  await notion.updateTask(id, { status: 'in_progress', worktreePath, tmuxSession: sessionName });

  // Initialize claude-workflow in worktree if not already done
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

app.post('/api/tasks/:id/stop', async (req, res) => {
  const { id } = req.params;
  const tasks = await notion.getTasks();
  const task = tasks.find(t => t.id === id);
  if (task?.tmuxSession) ptyManager.killSession(task.tmuxSession);
  if (task?.worktreePath) unwatchProgress(task.worktreePath);
  await notion.updateTask(id, { status: 'done' });
  res.json({ ok: true });
});

async function recoverSessions() {
  const aliveSessions = ptyManager.listAliveSessions();
  const tasks = await notion.getTasks();
  for (const task of tasks) {
    if (task.status === 'in_progress' && task.tmuxSession) {
      if (aliveSessions.includes(task.tmuxSession)) {
        ptyManager.attachSession(task.tmuxSession);
        if (task.worktreePath) watchProgress(task.worktreePath, task.id);
        console.log(`Recovered session: ${task.tmuxSession}`);
      } else {
        await notion.updateTask(task.id, { status: 'interrupted' });
        console.log(`Session dead, marked interrupted: ${task.tmuxSession}`);
      }
    }
  }
}

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
server.listen(PORT, async () => {
  console.log(`Claude Code Manager running on http://localhost:${PORT}`);
  await recoverSessions();
});

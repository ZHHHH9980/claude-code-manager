require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const ptyManager = require('./pty-manager');
const { TaskChatRuntimeManager } = require('./task-chat-runtime');
const { createSessionClient } = require('./session-client');
const { createOriginPolicy, createAccessTokenMiddleware } = require('./http-bootstrap');
const { createTaskProcessService } = require('./task-process');
const {
  normalizeAdapterModel,
  isCommandAvailable,
  buildProjectContextEnvExports,
  launchAdapterInSession,
} = require('./adapter-launch');
const { resolveTaskWorkingDirectory, syncProjectInstructionFiles } = require('./project-context');
const { createTaskChatService } = require('./task-chat-service');
const { createAgentService } = require('./agent-service');
const { resolveAdapter } = require('./adapters');
const { registerTaskChatRoutes } = require('./task-chat-routes');
const { registerAgentChatRoutes } = require('./agent-routes');
const {
  buildTaskSessionPrompt,
  isTaskStatusQuery,
  buildTaskStatusReply,
} = require('./task-chat-helpers');
const { startServerAndRecover } = require('./runtime-lifecycle');

const { corsOptions } = createOriginPolicy({});
const PORT = process.env.CHAT_MANAGER_PORT || 3002;
const WORKFLOW_DIR = process.env.WORKFLOW_DIR || path.join(process.env.HOME, 'Documents/claude-workflow');
const ROOT_DIR = path.join(__dirname, '..');
const MODEL_ALIASES = {
  codex: {
    'gpt-5.3-codex': 'gpt-5.4',
  },
};

const app = express();
const server = http.createServer(app);
const taskChatRuntimeManager = new TaskChatRuntimeManager({
  logMetric: (event, payload) => console.log(`[chat-metric] ${JSON.stringify({ event, ...payload })}`),
});
const sessionClient = createSessionClient({
  ptyManager,
  baseUrl: process.env.SESSION_MANAGER_URL,
});

const taskProcessService = createTaskProcessService({
  db,
  fs: {},
  sessionClient,
  watchProgress: () => {},
  syncTaskToNotion: () => {},
  resolveAdapter,
  resolveTaskWorkingDirectory,
  syncProjectInstructionFiles,
  normalizeAdapterModel,
  buildProjectContextEnvExports,
  launchAdapterInSession,
  isCommandAvailable,
  modelAliases: MODEL_ALIASES,
  workflowDir: WORKFLOW_DIR,
  sessionsDir: '',
});

function ensureTaskProcess(task, opts = {}) {
  return taskProcessService.ensureTaskProcess(task, opts);
}

const taskChatService = createTaskChatService({
  db,
  sessionClient,
  taskChatRuntimeManager,
  ensureTaskProcess,
  buildTaskSessionPrompt,
  isTaskStatusQuery,
  buildTaskStatusReply,
  rootDir: ROOT_DIR,
});

const agentService = createAgentService({
  db,
  sessionClient,
  taskChatRuntimeManager,
  resolveAdapter,
  isCommandAvailable,
  launchAdapterInSession,
  modelAliases: MODEL_ALIASES,
  rootDir: ROOT_DIR,
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(createAccessTokenMiddleware({}));

registerTaskChatRoutes({ app, db, taskChatService });
registerAgentChatRoutes({ app, agentService });

app.post('/internal/chat/tasks/:id/stop', (req, res) => {
  taskChatRuntimeManager.stopTask(req.params.id, req.body?.reason || 'stop_task');
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'chat-manager' });
});

startServerAndRecover({
  server,
  port: PORT,
  logger: console,
  recoverSessions: () => {},
});

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const db = require('./db');
const { syncProjectToNotion, syncTaskToNotion } = require('./notion-sync');
const ptyManager = require('./pty-manager');
const { TaskChatRuntimeManager } = require('./task-chat-runtime');
const { registerAdapterRoutes } = require('./adapter-routes');
const {
  normalizeAdapterModel,
  isCommandAvailable,
  buildProjectContextEnvExports,
  launchAdapterInSession,
} = require('./adapter-launch');
const { resolveTaskWorkingDirectory, syncProjectInstructionFiles } = require('./project-context');
const { createAgentService } = require('./agent-service');
const { registerAgentRoutes } = require('./agent-routes');
const { createDeployService } = require('./deploy-service');
const { registerDeployRoutes } = require('./deploy-routes');
const { registerProjectTaskRoutes } = require('./project-task-routes');
const { createTaskChatService } = require('./task-chat-service');
const { registerTaskChatRoutes } = require('./task-chat-routes');
const {
  buildTaskSessionPrompt,
  isTaskStatusQuery,
  buildTaskStatusReply,
} = require('./task-chat-helpers');
const { createTaskProcessService } = require('./task-process');
const { registerTerminalHttpRoutes } = require('./terminal-http-routes');
const { normalizeSessionName } = require('./terminal-http-helpers');
const { registerTerminalSocketHandlers } = require('./terminal-socket');
const { createSessionClient } = require('./session-client');
const { createSessionServiceConfig } = require('./session-service-config');
const { createChatServiceConfig } = require('./chat-service-config');
const { createChatRuntimeControl } = require('./chat-runtime-control');
const {
  persistSessionBuffers,
  registerSigtermPersistence,
  startServerAndRecover,
} = require('./runtime-lifecycle');
const {
  createOriginPolicy,
  createAccessTokenMiddleware,
} = require('./http-bootstrap');
const { watchProgress, unwatchProgress } = require('./file-watcher');
const { resolveAdapter, listAdapters } = require('./adapters');

const WORKFLOW_DIR = process.env.WORKFLOW_DIR || path.join(process.env.HOME, 'Documents/claude-workflow');
const SESSIONS_DIR = path.join(__dirname, '../data/sessions');
const MODEL_ALIASES = {
  codex: {
    'gpt-5.3-codex': 'gpt-5.4',
  },
};
const { corsOptions, socketCorsOptions } = createOriginPolicy({});
const sessionServiceConfig = createSessionServiceConfig({});
const chatServiceConfig = createChatServiceConfig({});

const app = express();
const server = http.createServer(app);
const io = sessionServiceConfig.enabled ? null : new Server(server, {
  cors: socketCorsOptions,
});
const taskChatRuntimeManager = new TaskChatRuntimeManager({
  logMetric: (event, payload) => logChatMetric(event, payload),
});
const ROOT_DIR = path.join(__dirname, '..');
const sessionClient = createSessionClient({
  ptyManager,
  baseUrl: sessionServiceConfig.internalUrl,
});
const chatRuntimeControl = createChatRuntimeControl({
  taskChatRuntimeManager,
  baseUrl: chatServiceConfig.internalUrl,
});
const taskProcessService = createTaskProcessService({
  db,
  fs,
  sessionClient,
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
const deployService = createDeployService({
  exec,
  rootDir: ROOT_DIR,
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(createAccessTokenMiddleware({}));

// Static files are now served by static-server.js
// app.use(express.static(path.join(__dirname, '../client/dist')));

registerProjectTaskRoutes({
  app,
  db,
  sessionClient,
  chatRuntimeControl,
  taskProcessService,
  listAdapters,
  normalizeAdapterModel,
  syncProjectToNotion,
  syncTaskToNotion,
  unwatchProgress,
});
registerAdapterRoutes({ app, listAdapters });

registerTerminalHttpRoutes({
  app,
  db,
  ptyManager,
  sessionClient,
  ensureTaskProcess,
  getBrowserTerminalSocketUrl: (req) => sessionServiceConfig.getBrowserUrl(req),
});

app.get('/api/runtime-config', (req, res) => {
  res.json({
    sessionManagerEnabled: sessionServiceConfig.enabled,
    terminalSocketUrl: sessionServiceConfig.getBrowserUrl(req),
    chatManagerEnabled: chatServiceConfig.enabled,
    chatBaseUrl: chatServiceConfig.getBrowserUrl(req),
  });
});

function logChatMetric(event, payload) {
  console.log(`[chat-metric] ${JSON.stringify({ event, ...payload })}`);
}

function ensureTaskProcess(task, opts = {}) {
  return taskProcessService.ensureTaskProcess(task, opts);
}
registerTaskChatRoutes({
  app,
  db,
  taskChatService,
  proxyBaseUrl: chatServiceConfig.internalUrl,
});
registerAgentRoutes({
  app,
  agentService,
  chatProxyBaseUrl: chatServiceConfig.internalUrl,
});
registerDeployRoutes({ app, deployService });

if (io) {
  registerTerminalSocketHandlers({
    io,
    ptyManager,
    normalizeSessionName,
  });
}

if (!sessionServiceConfig.enabled) {
  registerSigtermPersistence({
    processObject: process,
    persist: () => persistSessionBuffers({
      fs,
      sessionsDir: SESSIONS_DIR,
      ptyManager,
    }),
    exit: () => process.exit(0),
  });
}

const PORT = process.env.PORT || 3000;
startServerAndRecover({
  server,
  port: PORT,
  recoverSessions: () => taskProcessService.recoverSessions(),
});

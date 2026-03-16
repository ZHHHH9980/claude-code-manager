require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ptyManager = require('./pty-manager');
const { registerTerminalSocketHandlers } = require('./terminal-socket');
const { normalizeSessionName } = require('./terminal-http-helpers');
const {
  registerSessionManagerPublicRoutes,
  registerSessionManagerInternalRoutes,
} = require('./session-manager-routes');
const {
  createOriginPolicy,
  createAccessTokenMiddleware,
} = require('./http-bootstrap');
const {
  persistSessionBuffers,
  registerSigtermPersistence,
  startServerAndRecover,
} = require('./runtime-lifecycle');

const SESSIONS_DIR = path.join(__dirname, '../data/sessions');
const PORT = process.env.SESSION_MANAGER_PORT || 3001;
const { corsOptions, socketCorsOptions } = createOriginPolicy({});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: socketCorsOptions,
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(createAccessTokenMiddleware({}));

registerSessionManagerPublicRoutes({ app, ptyManager });
registerSessionManagerInternalRoutes({ app, ptyManager });
registerTerminalSocketHandlers({
  io,
  ptyManager,
  normalizeSessionName,
});

registerSigtermPersistence({
  processObject: process,
  persist: () => persistSessionBuffers({
    fs,
    sessionsDir: SESSIONS_DIR,
    ptyManager,
  }),
  exit: () => process.exit(0),
});

startServerAndRecover({
  server,
  port: PORT,
  logger: console,
  recoverSessions: () => {},
});

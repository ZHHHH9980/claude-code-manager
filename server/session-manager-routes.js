const {
  normalizeSessionName,
  sendTerminalJSONError,
  emitSSE,
  buildTerminalEmbedPage,
} = require('./terminal-http-helpers');

function getSessionState(sessionName, ptyManager) {
  const exists = ptyManager.sessionExists(sessionName);
  const entry = exists ? ptyManager.sessions.get(sessionName) : null;
  const output = exists ? ptyManager.getBufferedOutput(sessionName) : '';

  return {
    sessionName,
    exists,
    state: exists ? 'attached' : 'missing',
    code: exists ? 'ok' : 'session_not_found',
    attachedClients: exists ? Number(entry?.clients?.size || 0) : 0,
    bufferBytes: output.length,
    cols: exists ? Number(entry?.ptyProcess?.cols || 0) : 0,
    rows: exists ? Number(entry?.ptyProcess?.rows || 0) : 0,
    recoverable: exists,
  };
}

function registerSessionManagerPublicRoutes({ app, ptyManager }) {
  function buildState(sessionName) {
    return getSessionState(sessionName, ptyManager);
  }

  app.get('/api/terminal/:sessionName/state', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    res.json(buildState(sessionName));
  });

  app.get('/api/terminal/:sessionName/stream', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    if (!ptyManager.sessionExists(sessionName)) {
      return sendTerminalJSONError(
        res,
        404,
        'session_not_found',
        'session not found',
        { terminal: buildState(sessionName) }
      );
    }

    const replayRaw = String(req.query?.replay ?? '').trim().toLowerCase();
    const replayEnabled = !(replayRaw === '0' || replayRaw === 'false' || replayRaw === 'no');
    const replayBytesRaw = Number(req.query?.replay_bytes);
    const replayBytes = Number.isFinite(replayBytesRaw)
      ? Math.max(1024, Math.min(200000, Math.floor(replayBytesRaw)))
      : 40000;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    emitSSE(res, { type: 'ready', sessionName });
    let replay = replayEnabled ? ptyManager.getBufferedOutput(sessionName) : '';
    if (replay && replay.length > replayBytes) replay = replay.slice(-replayBytes);
    if (replay) emitSSE(res, { type: 'output', chunk: replay, replay: true });

    const unsubscribe = ptyManager.subscribeOutput(sessionName, (chunk) => {
      emitSSE(res, { type: 'output', chunk });
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(': ping\n\n');
      if (!ptyManager.sessionExists(sessionName)) {
        emitSSE(res, { type: 'done', message: 'session ended' });
        cleanup();
        res.end();
      }
    }, 15000);

    req.on('close', cleanup);
  });

  app.post('/api/terminal/:sessionName/input', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    if (!ptyManager.sessionExists(sessionName)) {
      return sendTerminalJSONError(
        res,
        404,
        'session_not_found',
        'session not found',
        { terminal: buildState(sessionName) }
      );
    }
    const data = typeof req.body?.data === 'string' ? req.body.data : '';
    if (!data) {
      return sendTerminalJSONError(res, 400, 'input_required', 'input data required');
    }
    ptyManager.sendInput(sessionName, data);
    res.json({ ok: true });
  });

  app.post('/api/terminal/:sessionName/resize', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    if (!ptyManager.sessionExists(sessionName)) {
      return sendTerminalJSONError(
        res,
        404,
        'session_not_found',
        'session not found',
        { terminal: buildState(sessionName) }
      );
    }
    const cols = Math.max(40, Math.min(400, Number(req.body?.cols) || 120));
    const rows = Math.max(10, Math.min(200, Number(req.body?.rows) || 30));
    ptyManager.resizeSession(sessionName, cols, rows);
    res.json({ ok: true, cols, rows });
  });

  app.get('/api/terminal/:sessionName/read', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    if (!ptyManager.sessionExists(sessionName)) {
      return sendTerminalJSONError(
        res,
        404,
        'session_not_found',
        'session not found',
        { terminal: buildState(sessionName) }
      );
    }
    const output = ptyManager.getBufferedOutput(sessionName) || '';
    const rawFrom = Number(req.query?.from);
    const hasFrom = Number.isFinite(rawFrom) && rawFrom >= 0;
    const rawTail = Number(req.query?.tail);
    const tail = Number.isFinite(rawTail)
      ? Math.max(1024, Math.min(200000, Math.floor(rawTail)))
      : 0;
    let from = hasFrom ? Math.floor(rawFrom) : 0;
    if (!hasFrom && tail > 0 && output.length > tail) {
      from = output.length - tail;
    }
    const safeFrom = Math.min(from, output.length);
    res.json({
      from: safeFrom,
      next: output.length,
      chunk: output.slice(safeFrom),
    });
  });

  app.get('/api/terminal/:sessionName/embed', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) return res.status(400).type('text/plain').send('invalid session name');
    if (!ptyManager.sessionExists(sessionName)) {
      return res.status(404).type('text/plain').send('session not found');
    }
    const accessToken = typeof req.query?.access_token === 'string' ? req.query.access_token : '';
    res.type('html').send(buildTerminalEmbedPage(sessionName, accessToken));
  });
}

function registerSessionManagerInternalRoutes({ app, ptyManager }) {
  app.get('/internal/sessions', (req, res) => {
    res.json({ sessions: ptyManager.listAliveSessions() });
  });

  app.post('/internal/sessions/ensure', (req, res) => {
    const sessionName = normalizeSessionName(req.body?.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    const cwd = String(req.body?.cwd || process.env.HOME || '/');
    try {
      ptyManager.ensureSession(sessionName, cwd);
      res.json(getSessionState(sessionName, ptyManager));
    } catch (err) {
      sendTerminalJSONError(res, 500, 'session_create_failed', err?.message || 'failed to ensure session');
    }
  });

  app.post('/internal/sessions/:sessionName/attach', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    try {
      ptyManager.attachSession(sessionName);
      res.json(getSessionState(sessionName, ptyManager));
    } catch (err) {
      sendTerminalJSONError(res, 404, 'session_not_found', err?.message || 'session not found');
    }
  });

  app.get('/internal/sessions/:sessionName/state', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    res.json(getSessionState(sessionName, ptyManager));
  });

  app.get('/internal/sessions/:sessionName/read', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    if (!ptyManager.sessionExists(sessionName)) {
      return sendTerminalJSONError(res, 404, 'session_not_found', 'session not found');
    }
    const output = ptyManager.getBufferedOutput(sessionName) || '';
    res.json({ from: 0, next: output.length, chunk: output });
  });

  app.post('/internal/sessions/:sessionName/input', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    if (!ptyManager.sessionExists(sessionName)) {
      return sendTerminalJSONError(res, 404, 'session_not_found', 'session not found');
    }
    const data = typeof req.body?.data === 'string' ? req.body.data : '';
    if (!data) {
      return sendTerminalJSONError(res, 400, 'input_required', 'input data required');
    }
    ptyManager.sendInput(sessionName, data);
    res.json({ ok: true });
  });

  app.post('/internal/sessions/:sessionName/resize', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    if (!ptyManager.sessionExists(sessionName)) {
      return sendTerminalJSONError(res, 404, 'session_not_found', 'session not found');
    }
    const cols = Math.max(40, Math.min(400, Number(req.body?.cols) || 120));
    const rows = Math.max(10, Math.min(200, Number(req.body?.rows) || 30));
    ptyManager.resizeSession(sessionName, cols, rows);
    res.json({ ok: true, cols, rows });
  });

  app.post('/internal/sessions/:sessionName/kill', (req, res) => {
    const sessionName = normalizeSessionName(req.params.sessionName);
    if (!sessionName) {
      return sendTerminalJSONError(res, 400, 'invalid_session_name', 'invalid session name');
    }
    ptyManager.killSession(sessionName);
    res.json({ ok: true });
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, service: 'session-manager' });
  });
}

module.exports = {
  getSessionState,
  registerSessionManagerPublicRoutes,
  registerSessionManagerInternalRoutes,
};

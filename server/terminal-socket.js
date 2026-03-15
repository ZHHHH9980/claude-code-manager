function registerTerminalSocketHandlers({
  io,
  ptyManager,
  normalizeSessionName,
}) {
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
}

module.exports = {
  registerTerminalSocketHandlers,
};

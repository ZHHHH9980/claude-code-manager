const { normalizeBaseUrl } = require('./session-service-config');

function createSessionClient({
  ptyManager,
  baseUrl = process.env.SESSION_MANAGER_URL,
  accessToken = process.env.SESSION_MANAGER_ACCESS_TOKEN || process.env.ACCESS_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const remoteEnabled = Boolean(normalizedBaseUrl);

  function buildHeaders(includeJson = false) {
    const headers = {};
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (includeJson) headers['content-type'] = 'application/json';
    return headers;
  }

  async function requestJson(pathname, { method = 'GET', body } = {}) {
    if (!fetchImpl) throw new Error('fetch is not available');
    const response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
      method,
      headers: buildHeaders(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const err = new Error(payload?.error || `session manager request failed (${response.status})`);
      err.status = response.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  if (!remoteEnabled) {
    return {
      isRemote() {
        return false;
      },
      async ensureSession(sessionName, cwd) {
        return ptyManager.ensureSession(sessionName, cwd);
      },
      async attachSession(sessionName) {
        return ptyManager.attachSession(sessionName);
      },
      async sessionExists(sessionName) {
        return ptyManager.sessionExists(sessionName);
      },
      async sendInput(sessionName, data) {
        return ptyManager.sendInput(sessionName, data);
      },
      async resizeSession(sessionName, cols, rows) {
        return ptyManager.resizeSession(sessionName, cols, rows);
      },
      async killSession(sessionName) {
        return ptyManager.killSession(sessionName);
      },
      async listAliveSessions() {
        return ptyManager.listAliveSessions();
      },
      async getSessionState(sessionName) {
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
      },
      async getBufferedOutput(sessionName) {
        return ptyManager.getBufferedOutput(sessionName);
      },
      getBaseUrl() {
        return '';
      },
    };
  }

  return {
    isRemote() {
      return true;
    },
    async ensureSession(sessionName, cwd) {
      return requestJson('/internal/sessions/ensure', {
        method: 'POST',
        body: { sessionName, cwd },
      });
    },
    async attachSession(sessionName) {
      return requestJson(`/internal/sessions/${encodeURIComponent(sessionName)}/attach`, {
        method: 'POST',
      });
    },
    async sessionExists(sessionName) {
      const payload = await requestJson(`/internal/sessions/${encodeURIComponent(sessionName)}/state`);
      return Boolean(payload?.exists);
    },
    async sendInput(sessionName, data) {
      return requestJson(`/internal/sessions/${encodeURIComponent(sessionName)}/input`, {
        method: 'POST',
        body: { data },
      });
    },
    async resizeSession(sessionName, cols, rows) {
      return requestJson(`/internal/sessions/${encodeURIComponent(sessionName)}/resize`, {
        method: 'POST',
        body: { cols, rows },
      });
    },
    async killSession(sessionName) {
      return requestJson(`/internal/sessions/${encodeURIComponent(sessionName)}/kill`, {
        method: 'POST',
      });
    },
    async listAliveSessions() {
      const payload = await requestJson('/internal/sessions');
      return Array.isArray(payload?.sessions) ? payload.sessions : [];
    },
    async getSessionState(sessionName) {
      return requestJson(`/internal/sessions/${encodeURIComponent(sessionName)}/state`);
    },
    async getBufferedOutput(sessionName) {
      const payload = await requestJson(`/internal/sessions/${encodeURIComponent(sessionName)}/read`);
      return String(payload?.chunk || '');
    },
    getBaseUrl() {
      return normalizedBaseUrl;
    },
  };
}

module.exports = {
  createSessionClient,
};

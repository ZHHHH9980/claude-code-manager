function normalizeSessionName(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) return '';
  return value;
}

function getTerminalState(sessionName, { ptyManager, db }) {
  const exists = ptyManager.sessionExists(sessionName);
  const entry = exists ? ptyManager.sessions.get(sessionName) : null;
  const tasks = db.getTasks();
  const owningTask = tasks.find((task) => task?.pty_session === sessionName) || null;
  const owningRunningTask = tasks.find(
    (task) => task?.pty_session === sessionName && task?.status === 'in_progress'
  ) || null;
  const output = exists ? ptyManager.getBufferedOutput(sessionName) : '';

  return {
    sessionName,
    exists,
    state: exists ? 'attached' : 'missing',
    code: exists ? 'ok' : 'session_not_found',
    attachedClients: exists ? Number(entry?.clients?.size || 0) : 0,
    bufferBytes: output.length,
    taskId: owningTask?.id || null,
    taskStatus: owningTask?.status || null,
    runningTaskId: owningRunningTask?.id || null,
    recoverable: exists,
  };
}

function sendTerminalJSONError(res, httpStatus, code, message, extra = {}) {
  res.status(httpStatus).json({
    error: message,
    code,
    ...extra,
  });
}

function emitSSE(res, payload) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildTerminalEmbedPage(sessionName, accessToken) {
  const encodedSession = encodeURIComponent(sessionName);
  const tokenQuery = accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : '';
  const readBaseUrl = `/api/terminal/${encodedSession}/read${tokenQuery}`;
  const inputUrl = `/api/terminal/${encodedSession}/input${tokenQuery}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>CCM Terminal Web</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: #0f1115;
      color: #e8eaf0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .topbar {
      padding: 10px 12px;
      border-bottom: 1px solid #2a2f3b;
      color: #c9d0df;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    #output {
      flex: 1;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      padding: 10px 12px;
      line-height: 1.3;
      font-size: 12px;
    }
    .status {
      color: #a0a9bc;
      font-size: 11px;
      white-space: nowrap;
    }
    .bar {
      border-top: 1px solid #2a2f3b;
      display: flex;
      gap: 8px;
      padding: 8px;
      background: #131722;
    }
    #cmd {
      flex: 1;
      border: 1px solid #3a4458;
      background: #0f1115;
      color: #e8eaf0;
      border-radius: 8px;
      padding: 10px;
      font: inherit;
      min-width: 0;
    }
    #send {
      border: 1px solid #4a556f;
      background: #1b2233;
      color: #f3f5fb;
      border-radius: 8px;
      padding: 0 14px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="topbar">
    <span>Web Terminal • ${sessionName}</span>
    <span id="status" class="status">connecting...</span>
  </div>
  <pre id="output"></pre>
  <div class="bar">
    <input id="cmd" placeholder="Type command and press Enter" autocomplete="off" autocapitalize="off" />
    <button id="send">Send</button>
  </div>
  <script>
    const statusEl = document.getElementById('status');
    const outputEl = document.getElementById('output');
    const cmdEl = document.getElementById('cmd');
    const sendEl = document.getElementById('send');
    const inputUrl = ${JSON.stringify(inputUrl)};
    let readOffset = 0;
    let pollTimer = null;
    let pendingPoll = false;
    let stopped = false;

    function setStatus(text) {
      statusEl.textContent = text;
    }

    function stopPolling(statusText, logText) {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (statusText) setStatus(statusText);
      if (logText) append('\\n[' + logText + ']\\n');
    }

    async function postJSON(url, payload) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    function sanitize(text) {
      return String(text || '')
        .replace(/\\r\\n/g, '\n')
        .replace(/\\r/g, '\n')
        .replace(/\\x1B\\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\\x1B\\][^\\x07]*(\\x07|\\x1B\\\\)/g, '')
        .replace(/[\\x00-\\x08\\x0B-\\x1F\\x7F]/g, '');
    }

    function append(text) {
      const clean = sanitize(text);
      if (!clean) return;
      outputEl.textContent += clean;
      if (outputEl.textContent.length > 200000) {
        outputEl.textContent = outputEl.textContent.slice(-150000);
      }
      outputEl.scrollTop = outputEl.scrollHeight;
    }

    function buildReadUrl(from, tail) {
      const base = ${JSON.stringify(readBaseUrl)};
      const params = [];
      if (Number.isFinite(from) && from >= 0) params.push('from=' + encodeURIComponent(String(from)));
      if (Number.isFinite(tail) && tail > 0) params.push('tail=' + encodeURIComponent(String(tail)));
      if (params.length === 0) return base;
      return base + (base.includes('?') ? '&' : '?') + params.join('&');
    }

    async function pollRead() {
      if (stopped) return;
      if (pendingPoll) return;
      pendingPoll = true;
      try {
        const resp = await fetch(buildReadUrl(readOffset, null), { cache: 'no-store' });
        if (!resp.ok) {
          if (resp.status === 401) {
            stopPolling('auth failed', 'unauthorized: check ACCESS_TOKEN');
            return;
          }
          if (resp.status === 404) {
            stopPolling('session missing', 'session not found; restart the task terminal');
            return;
          }
          throw new Error('HTTP ' + resp.status);
        }
        const payload = await resp.json();
        if (typeof payload.next === 'number') readOffset = payload.next;
        if (typeof payload.chunk === 'string' && payload.chunk.length > 0) append(payload.chunk);
        setStatus('connected');
      } catch (err) {
        append('\\n[read error] ' + (err && err.message ? err.message : 'read failed') + '\\n');
        setStatus('reconnecting...');
      } finally {
        pendingPoll = false;
        if (!stopped) pollTimer = setTimeout(pollRead, 700);
      }
    }

    async function bootstrapRead() {
      try {
        const resp = await fetch(buildReadUrl(null, 40000), { cache: 'no-store' });
        if (!resp.ok) {
          if (resp.status === 401) {
            stopPolling('auth failed', 'unauthorized: check ACCESS_TOKEN');
            return;
          }
          if (resp.status === 404) {
            stopPolling('session missing', 'session not found; restart the task terminal');
            return;
          }
          throw new Error('HTTP ' + resp.status);
        }
        const payload = await resp.json();
        if (typeof payload.next === 'number') readOffset = payload.next;
        if (typeof payload.chunk === 'string' && payload.chunk.length > 0) append(payload.chunk);
        setStatus('connected');
      } catch (err) {
        append('\\n[bootstrap error] ' + (err && err.message ? err.message : 'bootstrap failed') + '\\n');
        setStatus('reconnecting...');
      }
      if (!stopped) pollTimer = setTimeout(pollRead, 700);
    }

    async function sendCurrentInput() {
      if (stopped) {
        append('\\n[terminal unavailable; reopen task terminal]\\n');
        return;
      }
      const value = cmdEl.value || '';
      cmdEl.value = '';
      if (!value.trim()) return;
      append('\\n> ' + value + '\\n');
      try {
        const resp = await postJSON(inputUrl, { data: value + '\\n' });
        if (!resp.ok) {
          if (resp.status === 401) {
            stopPolling('auth failed', 'input rejected: unauthorized');
            return;
          }
          if (resp.status === 404) {
            stopPolling('session missing', 'input rejected: session not found');
            return;
          }
          throw new Error('HTTP ' + resp.status);
        }
      } catch {
        append('\\n[input failed]\\n');
      }
    }

    sendEl.addEventListener('click', sendCurrentInput);
    cmdEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      sendCurrentInput();
    });

    window.addEventListener('beforeunload', () => {
      if (pollTimer) clearTimeout(pollTimer);
    });

    bootstrapRead();
  </script>
</body>
</html>`;
}

module.exports = {
  normalizeSessionName,
  getTerminalState,
  sendTerminalJSONError,
  emitSSE,
  buildTerminalEmbedPage,
};

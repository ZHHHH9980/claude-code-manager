const path = require('path');
const { randomUUID } = require('crypto');

function createAgentService({
  db,
  sessionClient,
  taskChatRuntimeManager,
  resolveAdapter,
  isCommandAvailable,
  launchAdapterInSession,
  modelAliases = {},
  rootDir = path.join(__dirname, '..'),
  terminalSessionName = process.env.AGENT_TERMINAL_SESSION || 'claude-agent-home',
}) {
  const runtimeKey = '__agent_home__';
  let agentChatSessionId = db.getAgentSessionId();

  function resetAgentChat(reason = 'agent_reset') {
    taskChatRuntimeManager.stopTask(runtimeKey, reason);
    agentChatSessionId = null;
    db.setAgentSessionId(null);
  }

  function getHistory(limit = 400) {
    return db.getAgentChatMessages(limit);
  }

  function clearHistory() {
    resetAgentChat('agent_clear_history');
    db.clearAgentChatMessages();
  }

  async function startTerminal(mode = 'claude') {
    const resolved = resolveAdapter(mode);
    const adapter = resolved.adapter;
    if (resolved.usedLegacyAlias) {
      console.warn(
        `[adapter] legacy mode "${resolved.requestedName}" requested for agent terminal, fallback to "${resolved.resolvedName}"`,
      );
    }

    if (!isCommandAvailable(adapter.cli)) {
      return {
        sessionName: terminalSessionName,
        ptyOk: false,
        mode: adapter.name,
        error: `CLI not found: ${adapter.cli}`,
      };
    }

    let ptyOk = true;
    let error = null;
    try {
      const existed = await sessionClient.sessionExists(terminalSessionName);
      await sessionClient.ensureSession(terminalSessionName, rootDir);
      if (!existed) {
        setTimeout(() => {
          Promise.resolve(launchAdapterInSession(
              terminalSessionName,
              { adapter, model: adapter.defaultModel, context: 'agent terminal' },
              { sessionClient, aliases: modelAliases },
            )).catch((err) => {
            ptyOk = false;
            error = err?.message || String(err);
            console.warn('agent terminal sendInput failed:', err?.message || err);
          });
        }, 500);
      }
    } catch (err) {
      ptyOk = false;
      error = err?.message || String(err);
      console.warn('agent terminal unavailable:', err?.message || err);
    }
    return {
      sessionName: terminalSessionName,
      ptyOk,
      mode: adapter.name,
      error,
    };
  }

  async function stopTerminal() {
    try {
      await sessionClient.killSession(terminalSessionName);
    } catch {}
  }

  function prepareSSE(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`data: ${JSON.stringify({ ready: true })}\n\n`);
  }

  async function streamResponse(prompt, res) {
    const safePrompt = String(prompt || '').trim();
    if (!safePrompt) {
      return {
        handled: false,
        httpStatus: 400,
        body: { error: 'message required' },
      };
    }

    const hasSession = Boolean(agentChatSessionId);
    const sessionId = agentChatSessionId || randomUUID();
    if (!hasSession) {
      agentChatSessionId = sessionId;
      db.setAgentSessionId(sessionId);
    }
    db.appendAgentChatMessage('user', safePrompt);

    prepareSSE(res);
    let clientClosed = false;
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15000);
    const cleanup = () => clearInterval(heartbeat);

    res.on('close', () => {
      clientClosed = true;
      cleanup();
    });

    let assistantText = '';
    try {
      await taskChatRuntimeManager.send({
        taskId: runtimeKey,
        cwd: rootDir,
        sessionId,
        resumeSession: hasSession,
        prompt: safePrompt,
        timeoutMs: 300000,
        onAssistantText: (text) => {
          if (clientClosed || res.writableEnded) return;
          assistantText += String(text || '');
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        },
      });

      cleanup();
      if (assistantText.trim()) db.appendAgentChatMessage('assistant', assistantText);
      if (!clientClosed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: true, code: 0, signal: null })}\n\n`);
        res.end();
      }
      return { handled: true };
    } catch (err) {
      cleanup();
      taskChatRuntimeManager.stopTask(runtimeKey, 'agent_runtime_error');
      const msg = String(err?.message || 'agent chat runtime error');
      if (/not logged in|authentication_failed|session .* not found|invalid session/i.test(msg)) {
        agentChatSessionId = null;
        db.setAgentSessionId(null);
      }
      if (res.writableEnded || clientClosed) return { handled: true };
      res.write(`data: ${JSON.stringify({
        error: true,
        error_code: 'AGENT_RUNTIME_ERROR',
        text: msg,
        done: true,
      })}\n\n`);
      res.end();
      return { handled: true };
    }
  }

  return {
    getHistory,
    clearHistory,
    startTerminal,
    stopTerminal,
    streamResponse,
  };
}

module.exports = {
  createAgentService,
};

const { proxySessionManagerRequest } = require('./session-proxy');

function registerAgentChatRoutes({ app, agentService, proxyBaseUrl = '' }) {
  if (proxyBaseUrl) {
    app.get('/api/agent/history', async (req, res) => {
      await proxySessionManagerRequest({
        req,
        res,
        sessionManagerUrl: proxyBaseUrl,
        targetPath: req.path,
      });
    });

    app.delete('/api/agent/history', async (req, res) => {
      await proxySessionManagerRequest({
        req,
        res,
        sessionManagerUrl: proxyBaseUrl,
        targetPath: req.path,
      });
    });

    app.post('/api/agent', async (req, res) => {
      await proxySessionManagerRequest({
        req,
        res,
        sessionManagerUrl: proxyBaseUrl,
        targetPath: req.path,
      });
    });
    return;
  }

  app.get('/api/agent/history', (req, res) => {
    res.json({ messages: agentService.getHistory(400) });
  });

  app.delete('/api/agent/history', (req, res) => {
    agentService.clearHistory();
    res.json({ ok: true });
  });

  app.post('/api/agent', async (req, res) => {
    try {
      const result = await agentService.streamResponse(req.body?.message, res);
      if (!result?.handled) {
        res.status(result?.httpStatus || 500).json(result?.body || { error: 'agent chat failed' });
      }
    } catch (err) {
      res.status(500).json({ error: err?.message || 'agent chat failed' });
    }
  });
}

function registerAgentTerminalRoutes({ app, agentService }) {
  app.post('/api/agent/terminal/start', async (req, res) => {
    const payload = await agentService.startTerminal(req.body?.mode);
    res.json(payload);
  });

  app.post('/api/agent/terminal/stop', async (req, res) => {
    await agentService.stopTerminal();
    res.json({ ok: true });
  });
}

function registerAgentRoutes({ app, agentService, chatProxyBaseUrl = '' }) {
  registerAgentChatRoutes({ app, agentService, proxyBaseUrl: chatProxyBaseUrl });
  registerAgentTerminalRoutes({ app, agentService });
}

module.exports = {
  registerAgentChatRoutes,
  registerAgentTerminalRoutes,
  registerAgentRoutes,
};

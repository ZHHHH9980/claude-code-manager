function registerAgentRoutes({ app, agentService }) {
  app.get('/api/agent/history', (req, res) => {
    res.json({ messages: agentService.getHistory(400) });
  });

  app.delete('/api/agent/history', (req, res) => {
    agentService.clearHistory();
    res.json({ ok: true });
  });

  app.post('/api/agent/terminal/start', (req, res) => {
    const payload = agentService.startTerminal(req.body?.mode);
    res.json(payload);
  });

  app.post('/api/agent/terminal/stop', (req, res) => {
    agentService.stopTerminal();
    res.json({ ok: true });
  });

  app.post('/api/agent', async (req, res) => {
    try {
      const result = await agentService.streamResponse(req.body?.message, res);
      if (result?.handled) return;
      res.status(result?.httpStatus || 500).json(result?.body || { error: 'agent chat failed' });
    } catch (err) {
      if (res.writableEnded) return;
      res.status(500).json({ error: err?.message || 'agent chat failed' });
    }
  });
}

module.exports = {
  registerAgentRoutes,
};

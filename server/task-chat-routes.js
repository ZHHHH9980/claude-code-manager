function registerTaskChatRoutes({ app, db, taskChatService }) {
  app.get('/api/tasks/:id/chat/history', (req, res) => {
    const { id } = req.params;
    const task = db.getTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json({ messages: taskChatService.getHistory(id, 300) });
  });

  app.delete('/api/tasks/:id/chat/history', (req, res) => {
    const { id } = req.params;
    const task = db.getTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    taskChatService.clearHistory(id);
    res.json({ ok: true });
  });

  app.post('/api/tasks/:id/chat', async (req, res) => {
    try {
      const result = await taskChatService.streamResponse(req.params.id, req.body?.message, res);
      if (result?.handled) return;
      res.status(result?.httpStatus || 500).json(result?.body || { error: 'task chat failed' });
    } catch (err) {
      if (res.writableEnded) return;
      res.status(500).json({ error: err?.message || 'task chat failed' });
    }
  });

  app.post('/api/tasks/:id/stop-chat', (req, res) => {
    // Keep task runtime alive until task is done/deleted; closing chat modal should not stop it.
    res.json({ ok: true });
  });
}

module.exports = {
  registerTaskChatRoutes,
};

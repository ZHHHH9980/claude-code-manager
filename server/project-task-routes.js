function registerProjectTaskRoutes({
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
}) {
  app.get('/api/projects', (req, res) => {
    res.json(db.getProjects());
  });

  app.post('/api/projects', (req, res) => {
    const project = db.createProject(req.body);
    syncProjectToNotion(project);
    res.json(project);
  });

  app.put('/api/projects/:id', (req, res) => {
    const { id } = req.params;
    const existing = db.getProject(id);
    if (!existing) return res.status(404).json({ error: 'project not found' });
    const updated = db.updateProject(id, req.body);
    syncProjectToNotion(updated);
    res.json(updated);
  });

  app.delete('/api/projects/:id', (req, res) => {
    const { id } = req.params;
    const projectTasks = db.getTasks(id);
    for (const task of projectTasks) {
      chatRuntimeControl.stopTask(task.id, 'project_delete').catch(() => {});
    }
    const ok = db.deleteProject(id);
    if (!ok) return res.status(404).json({ error: 'project not found' });
    res.json({ ok: true, deleted: id });
  });

  app.get('/api/tasks', (req, res) => {
    const { projectId } = req.query;
    res.json(db.getTasks(projectId));
  });

  app.post('/api/tasks', (req, res) => {
    const allAdapters = listAdapters();
    const defaultAdapter = allAdapters[0] || { name: 'claude', defaultModel: 'claude-sonnet-4-5' };
    const task = db.createTask({
      ...req.body,
      mode: req.body.mode || defaultAdapter.name,
      model: normalizeAdapterModel(defaultAdapter, req.body.model || defaultAdapter.defaultModel),
    });
    syncTaskToNotion(task);
    res.json(task);
  });

  app.post('/api/tasks/:id/start', async (req, res) => {
    const { id } = req.params;
    const { worktreePath, branch, model, mode } = req.body;
    const result = await taskProcessService.startTaskSession(id, {
      requestedPath: worktreePath,
      branch,
      model,
      mode,
    });
    if (result.httpStatus) {
      return res.status(result.httpStatus).json(result.body);
    }
    res.json(result.body);
  });

  app.post('/api/tasks/:id/stop', async (req, res) => {
    const { id } = req.params;
    const task = db.getTask(id);
    await chatRuntimeControl.stopTask(id, 'task_stop');
    if (task?.pty_session) await sessionClient.killSession(task.pty_session);
    if (task?.worktree_path) unwatchProgress(task.worktree_path);
    const updated = db.updateTask(id, { status: 'done' });
    syncTaskToNotion(updated);
    res.json({ ok: true });
  });

  app.delete('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    const task = db.getTask(id);
    await chatRuntimeControl.stopTask(id, 'task_delete');
    if (task?.pty_session) await sessionClient.killSession(task.pty_session);
    if (task?.worktree_path) unwatchProgress(task.worktree_path);
    const ok = db.deleteTask(id);
    if (!ok) return res.status(404).json({ error: 'task not found' });
    res.json({ ok: true, deleted: id });
  });
}

module.exports = {
  registerProjectTaskRoutes,
};

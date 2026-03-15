function registerAdapterRoutes({ app, listAdapters }) {
  app.get('/api/adapters', (req, res) => {
    const payload = listAdapters().map((adapter) => ({
      name: adapter.name,
      label: adapter.label,
      color: adapter.color,
      models: Array.isArray(adapter.models) ? adapter.models : [],
      defaultModel: adapter.defaultModel || null,
      supportsChatMode: Boolean(adapter.chatMode),
    }));
    res.json(payload);
  });
}

module.exports = {
  registerAdapterRoutes,
};

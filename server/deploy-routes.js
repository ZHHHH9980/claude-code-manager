function registerDeployRoutes({ app, deployService }) {
  app.post('/api/deploy', async (req, res) => {
    try {
      const out = await deployService.selfDeploy();
      res.json({ ok: true, output: out.slice(-500) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/webhook/github', async (req, res) => {
    const event = req.headers['x-github-event'];
    if (event !== 'push') return res.json({ ignored: true });
    const branch = req.body?.ref;
    if (branch !== 'refs/heads/main') return res.json({ ignored: true, branch });
    res.json({ ok: true, deploying: true });
    try {
      await deployService.selfDeploy();
    } catch (err) {
      console.error('Webhook deploy failed:', err.message);
    }
  });
}

module.exports = {
  registerDeployRoutes,
};

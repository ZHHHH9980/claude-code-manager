const path = require('path');

function persistSessionBuffers({
  fs,
  sessionsDir,
  ptyManager,
  pathModule = path,
  logger = console,
}) {
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (const [sessionName, entry] of ptyManager.sessions) {
      if (entry.outputBuffer) {
        fs.writeFileSync(pathModule.join(sessionsDir, `${sessionName}.buf`), entry.outputBuffer);
      }
    }
  } catch (err) {
    logger.error('Failed to persist session buffers:', err?.message);
  }
}

function registerSigtermPersistence({
  processObject = process,
  persist,
  exit = () => process.exit(0),
}) {
  processObject.on('SIGTERM', () => {
    persist();
    exit();
  });
}

function startServerAndRecover({
  server,
  port,
  logger = console,
  recoverSessions,
}) {
  server.listen(port, () => {
    logger.log(`Claude Code Manager running on http://localhost:${port}`);
    recoverSessions();
  });
}

module.exports = {
  persistSessionBuffers,
  registerSigtermPersistence,
  startServerAndRecover,
};

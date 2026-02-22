const chokidar = require('chokidar');
const fs = require('fs');
const { appendProgress } = require('./notion');

const watchers = new Map();

function watchProgress(worktreePath, taskId) {
  if (watchers.has(worktreePath)) return;
  const filePath = `${worktreePath}/PROGRESS.md`;
  let lastContent = '';

  const watcher = chokidar.watch(filePath, { ignoreInitial: true });
  watcher.on('change', async () => {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content !== lastContent) {
        lastContent = content;
        const timestamp = new Date().toISOString();
        await appendProgress(taskId, `[${timestamp}]\n${content}`);
      }
    } catch (err) {
      console.error('file-watcher error:', err.message);
    }
  });

  watchers.set(worktreePath, { taskId, watcher });
}

function unwatchProgress(worktreePath) {
  const entry = watchers.get(worktreePath);
  if (entry) {
    entry.watcher.close();
    watchers.delete(worktreePath);
  }
}

module.exports = { watchProgress, unwatchProgress };

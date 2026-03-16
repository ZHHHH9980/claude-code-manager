const path = require('path');
const { execSync } = require('child_process');

function createTaskProcessService({
  db,
  fs,
  sessionClient,
  watchProgress,
  syncTaskToNotion,
  resolveAdapter,
  resolveTaskWorkingDirectory,
  syncProjectInstructionFiles,
  normalizeAdapterModel,
  buildProjectContextEnvExports,
  launchAdapterInSession,
  isCommandAvailable,
  modelAliases = {},
  workflowDir,
  sessionsDir,
}) {
  function buildTaskSessionName(taskId) {
    const safeTaskId = String(taskId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || 'task';
    return `claude-task-${safeTaskId}`;
  }

  function syncInstructionFilesSafe(cwd, task, project) {
    try {
      syncProjectInstructionFiles(cwd, { task, project });
    } catch (err) {
      console.warn(`failed to sync instruction files for task ${task?.id || 'unknown'}:`, err?.message || err);
    }
  }

  function launchTaskAdapter(sessionName, { adapter, model, context, sessionEnvExports }) {
    return launchAdapterInSession(
      sessionName,
      { adapter, model, context, sessionEnvExports },
      { sessionClient, aliases: modelAliases },
    );
  }

  async function startTaskSession(taskId, { requestedPath, model, mode } = {}) {
    const existingTask = db.getTask(taskId);
    if (!existingTask) {
      return {
        httpStatus: 404,
        body: { error: 'task not found' },
      };
    }

    const project = existingTask.project_id ? db.getProject(existingTask.project_id) : null;
    const { cwd: resolvedWorktreePath, error: cwdError } = resolveTaskWorkingDirectory({
      task: existingTask,
      project,
      requestedPath,
    });

    const resolved = resolveAdapter(mode);
    const adapter = resolved.adapter;
    if (resolved.usedLegacyAlias) {
      console.warn(`[adapter] legacy mode "${resolved.requestedName}" requested, fallback to "${resolved.resolvedName}"`);
    }
    const finalModel = normalizeAdapterModel(adapter, model, modelAliases);
    const sessionName = buildTaskSessionName(taskId);

    if (!resolvedWorktreePath) {
      return {
        httpStatus: 400,
        body: {
          sessionName,
          ptyOk: false,
          mode: adapter.name,
          model: finalModel,
          error: cwdError,
        },
      };
    }

    if (!isCommandAvailable(adapter.cli)) {
      return {
        httpStatus: 400,
        body: {
          sessionName,
          ptyOk: false,
          mode: adapter.name,
          model: finalModel,
          error: `CLI not found: ${adapter.cli}`,
        },
      };
    }

    const task = db.updateTask(taskId, {
      status: 'in_progress',
      worktreePath: resolvedWorktreePath,
      ptySession: sessionName,
      mode: adapter.name,
      model: finalModel,
    });
    const sessionEnvExports = buildProjectContextEnvExports(task, project);
    syncTaskToNotion(task);
    syncInstructionFilesSafe(resolvedWorktreePath, task, project);

    try {
      execSync(`${workflowDir}/install.sh init`, { cwd: resolvedWorktreePath, stdio: 'ignore' });
    } catch {
      console.log('Workflow init skipped or already done');
    }

    let ptyOk = true;
    let error = null;
    try {
      const existed = await sessionClient.sessionExists(sessionName);
      if (existed) {
        await sessionClient.killSession(sessionName);
      }
      await sessionClient.ensureSession(sessionName, resolvedWorktreePath);
      setTimeout(() => {
        Promise.resolve(launchTaskAdapter(sessionName, {
            adapter,
            model: finalModel,
            context: `start task ${taskId}`,
            sessionEnvExports,
          })).catch((err) => {
          ptyOk = false;
          error = err?.message || String(err);
          console.warn(`pty sendInput failed for task ${taskId}:`, err?.message || err);
        });
      }, 500);
    } catch (err) {
      ptyOk = false;
      error = err?.message || String(err);
      console.warn(`pty unavailable for task ${taskId}:`, err?.message || err);
    }

    watchProgress(resolvedWorktreePath, taskId);
    return {
      body: { sessionName, ptyOk, mode: adapter.name, model: finalModel, error },
    };
  }

  async function ensureTaskProcess(task, opts = {}) {
    const { ensurePty = true } = opts;
    if (!task) return null;

    const resolved = resolveAdapter(task.mode);
    const adapter = resolved.adapter;
    if (resolved.usedLegacyAlias) {
      console.warn(`[adapter] legacy mode "${resolved.requestedName}" detected, fallback to "${resolved.resolvedName}"`);
    }

    const sessionName = task.pty_session || buildTaskSessionName(task.id);
    const finalModel = normalizeAdapterModel(adapter, task.model, modelAliases);
    const project = task.project_id ? db.getProject(task.project_id) : null;
    const { cwd, error: cwdError } = resolveTaskWorkingDirectory({ task, project });
    if (!cwd) {
      console.warn(`task ${task.id} skipped: ${cwdError}`);
      return null;
    }

    const sessionEnvExports = buildProjectContextEnvExports(task, project);
    syncInstructionFilesSafe(cwd, task, project);

    if (ensurePty) {
      const existed = await sessionClient.sessionExists(sessionName);
      try {
        await sessionClient.ensureSession(sessionName, cwd || process.env.HOME || '/');
        if (!existed) {
          setTimeout(() => {
            if (!isCommandAvailable(adapter.cli)) {
              console.warn(`task ${task.id} launch skipped: CLI not found: ${adapter.cli}`);
              return;
            }
            Promise.resolve(launchTaskAdapter(sessionName, {
                adapter,
                model: finalModel,
                context: `ensure task ${task.id}`,
                sessionEnvExports,
              })).catch((err) => {
              console.warn(`pty sendInput failed for task ${task.id}:`, err?.message || err);
            });
          }, 500);
        }
      } catch (err) {
        console.warn(`pty ensureSession failed for task ${task.id}:`, err?.message || err);
      }
    }

    if (
      task.pty_session !== sessionName
      || task.status !== 'in_progress'
      || task.mode !== adapter.name
      || task.model !== finalModel
    ) {
      const updated = db.updateTask(task.id, {
        ptySession: sessionName,
        status: 'in_progress',
        mode: adapter.name,
        model: finalModel,
      });
      syncTaskToNotion(updated);
    }

    watchProgress(cwd, task.id);
    return { sessionName, cwd };
  }

  async function recoverSessions() {
    const aliveSessions = await sessionClient.listAliveSessions();
    const tasks = db.getTasks();
    for (const task of tasks) {
      if (task.status !== 'in_progress' || !task.pty_session) continue;

      if (aliveSessions.includes(task.pty_session)) {
        try { await sessionClient.attachSession(task.pty_session); } catch {}
        if (task.worktree_path) watchProgress(task.worktree_path, task.id);
        console.log(`Recovered session: ${task.pty_session}`);
        continue;
      }

      const bufFile = path.join(sessionsDir, `${task.pty_session}.buf`);
      let savedBuffer = '';
      try {
        savedBuffer = fs.readFileSync(bufFile, 'utf8');
      } catch {}

      try {
        await sessionClient.ensureSession(task.pty_session, task.worktree_path);
        if (!sessionClient.isRemote() && savedBuffer) {
          const entry = await sessionClient.attachSession(task.pty_session);
          entry.outputBuffer = `${savedBuffer}\r\n\x1b[33m[session auto-recovered after server restart]\x1b[0m\r\n`;
        }
        if (task.worktree_path) watchProgress(task.worktree_path, task.id);

        setTimeout(() => {
          const resolved = resolveAdapter(task.mode);
          const adapter = resolved.adapter;
          if (resolved.usedLegacyAlias) {
            console.warn(
              `[adapter] legacy mode "${resolved.requestedName}" detected during recovery, fallback to "${resolved.resolvedName}"`,
            );
          }
          if (!isCommandAvailable(adapter.cli)) {
            console.warn(`recover task ${task.id} skipped: CLI not found: ${adapter.cli}`);
            return;
          }
          const project = task?.project_id ? db.getProject(task.project_id) : null;
          Promise.resolve(launchTaskAdapter(task.pty_session, {
              adapter,
              model: task.model || adapter.defaultModel,
              context: `recover task ${task.id}`,
              sessionEnvExports: buildProjectContextEnvExports(task, project),
            })).catch(() => {});
        }, 500);

        console.log(`Auto-restarted session: ${task.pty_session}`);
      } catch {
        db.updateTask(task.id, { status: 'interrupted' });
        console.log(`Failed to restart session, marked interrupted: ${task.pty_session}`);
      }
    }
  }

  return {
    startTaskSession,
    ensureTaskProcess,
    recoverSessions,
  };
}

module.exports = {
  createTaskProcessService,
};

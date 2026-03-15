const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

const { createTaskProcessService } = require('../server/task-process');

describe('task-process', () => {
  it('returns a 400 payload when task working directory cannot be resolved', () => {
    const service = createTaskProcessService({
      db: {
        getTask: () => ({ id: 't1', project_id: 'p1' }),
        getProject: () => ({ id: 'p1', github_repo: 'owner/repo' }),
      },
      fs: {},
      ptyManager: {},
      watchProgress: () => {},
      syncTaskToNotion: () => {},
      resolveAdapter: () => ({ adapter: { name: 'codex', cli: 'codex', defaultModel: 'gpt-5.4' }, usedLegacyAlias: false }),
      resolveTaskWorkingDirectory: () => ({ cwd: null, error: 'missing cwd' }),
      syncProjectInstructionFiles: () => {},
      normalizeAdapterModel: () => 'gpt-5.4',
      buildProjectContextEnvExports: () => '',
      launchAdapterInSession: () => {},
      isCommandAvailable: () => true,
      workflowDir: '/tmp/workflow',
      sessionsDir: '/tmp/sessions',
    });

    const result = service.startTaskSession('t1', { requestedPath: '/tmp/nope', mode: 'codex' });
    assert.equal(result.httpStatus, 400);
    assert.equal(result.body.ptyOk, false);
    assert.equal(result.body.error, 'missing cwd');
  });

  it('returns null from ensureTaskProcess when cwd resolution fails', () => {
    const service = createTaskProcessService({
      db: { getProject: () => ({ id: 'p1' }), updateTask: () => null },
      fs: {},
      ptyManager: {},
      watchProgress: () => {},
      syncTaskToNotion: () => {},
      resolveAdapter: () => ({ adapter: { name: 'claude', cli: 'claude' }, usedLegacyAlias: false }),
      resolveTaskWorkingDirectory: () => ({ cwd: null, error: 'missing cwd' }),
      syncProjectInstructionFiles: () => {},
      normalizeAdapterModel: () => 'claude-sonnet-4-5',
      buildProjectContextEnvExports: () => '',
      launchAdapterInSession: () => {},
      isCommandAvailable: () => true,
      workflowDir: '/tmp/workflow',
      sessionsDir: '/tmp/sessions',
    });

    const runtime = service.ensureTaskProcess({ id: 't1', project_id: 'p1', mode: 'claude' }, { ensurePty: false });
    assert.equal(runtime, null);
  });

  it('returns a stable session payload when starting a task succeeds', () => {
    const updateTask = mock.fn(() => ({
      id: 't1',
      project_id: 'p1',
      title: 'Refactor server',
      branch: 'main',
      worktree_path: '/tmp/repo',
      mode: 'codex',
      model: 'gpt-5.4',
    }));
    const ensureSession = mock.fn();

    const service = createTaskProcessService({
      db: {
        getTask: () => ({ id: 't1', project_id: 'p1', title: 'Refactor server', branch: 'main' }),
        getProject: () => ({ id: 'p1', name: 'CCM', repo_path: '/tmp/repo' }),
        updateTask,
      },
      fs: {},
      ptyManager: {
        sessionExists: () => false,
        ensureSession,
        killSession: () => {},
      },
      watchProgress: () => {},
      syncTaskToNotion: () => {},
      resolveAdapter: () => ({ adapter: { name: 'codex', cli: 'codex', defaultModel: 'gpt-5.4' }, usedLegacyAlias: false }),
      resolveTaskWorkingDirectory: () => ({ cwd: '/tmp/repo', error: null }),
      syncProjectInstructionFiles: () => {},
      normalizeAdapterModel: () => 'gpt-5.4',
      buildProjectContextEnvExports: () => 'export FOO=bar',
      launchAdapterInSession: () => {},
      isCommandAvailable: () => true,
      workflowDir: '/tmp/workflow',
      sessionsDir: '/tmp/sessions',
    });

    const result = service.startTaskSession('t1', { requestedPath: '/tmp/repo', mode: 'codex' });
    assert.equal(result.body.sessionName, 'claude-task-t1');
    assert.equal(result.body.ptyOk, true);
    assert.equal(result.body.mode, 'codex');
    assert.equal(ensureSession.mock.calls.length, 1);
    assert.equal(updateTask.mock.calls.length, 1);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAdapterModel,
  buildAdapterLaunchCommand,
  buildProjectContextEnvExports,
} = require('../server/adapter-launch');

describe('adapter-launch', () => {
  it('normalizes aliased adapter models', () => {
    const model = normalizeAdapterModel(
      { name: 'codex', defaultModel: 'gpt-5.4' },
      'gpt-5.3-codex',
      { codex: { 'gpt-5.3-codex': 'gpt-5.4' } },
    );
    assert.equal(model, 'gpt-5.4');
  });

  it('builds adapter launch command with model and default args', () => {
    const command = buildAdapterLaunchCommand(
      { name: 'codex', cli: 'codex', defaultArgs: ['--foo', 'bar'] },
      'gpt-5.4',
    );
    assert.equal(command, 'codex --model gpt-5.4 --foo bar');
  });

  it('builds project context env exports from task and project metadata', () => {
    const exports = buildProjectContextEnvExports(
      { id: 't1', title: 'Refactor server', branch: 'main', project_id: 'p1', worktree_path: '/tmp/work' },
      { id: 'p1', name: 'CCM', repo_path: '/tmp/repo', github_repo: 'owner/repo' },
    );
    assert.match(exports, /CCM_TASK_ID='t1'/);
    assert.match(exports, /CCM_PROJECT_NAME='CCM'/);
    assert.match(exports, /CCM_PROJECT_GITHUB_REPO='owner\/repo'/);
  });
});

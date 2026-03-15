const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTaskSessionPrompt,
  isTaskStatusQuery,
  buildTaskStatusReply,
} = require('../server/task-chat-helpers');

describe('task-chat-helpers', () => {
  it('builds a bootstrap task session prompt with current task context', () => {
    const prompt = buildTaskSessionPrompt(
      { id: 't1', title: 'Refactor server', status: 'in_progress', branch: 'main' },
      { name: 'CCM', repo_path: '/tmp/repo', github_repo: 'owner/repo' },
      'Continue refactor',
      true,
    );
    assert.match(prompt, /Task Session Chat/);
    assert.match(prompt, /task_id: t1/);
    assert.match(prompt, /project_github_repo: owner\/repo/);
  });

  it('detects progress and status queries in Chinese and English', () => {
    assert.equal(isTaskStatusQuery('现在进度怎么样'), true);
    assert.equal(isTaskStatusQuery('what is the progress?'), true);
    assert.equal(isTaskStatusQuery('open the settings page'), false);
  });

  it('builds a concise task status reply', () => {
    const reply = buildTaskStatusReply(
      { title: 'Refactor server', status: 'in_progress', branch: 'main', updated_at: '2026-03-15T00:00:00Z' },
      { name: 'CCM', github_repo: 'owner/repo' },
      true,
    );
    assert.match(reply, /running process attached: yes/);
    assert.match(reply, /github repo: owner\/repo/);
  });
});

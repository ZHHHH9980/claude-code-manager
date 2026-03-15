const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeGithubUrl,
  resolveTaskWorkingDirectory,
  syncProjectInstructionFiles,
} = require('../server/project-context');

describe('project-context', () => {
  it('normalizes owner/repo github metadata into a full url', () => {
    assert.equal(normalizeGithubUrl('openai/codex'), 'https://github.com/openai/codex');
    assert.equal(normalizeGithubUrl('https://github.com/openai/codex'), 'https://github.com/openai/codex');
    assert.equal(normalizeGithubUrl(''), '');
  });

  it('returns a clear error when only github metadata exists but no local checkout path is valid', () => {
    const result = resolveTaskWorkingDirectory({
      task: { worktree_path: '/tmp/does-not-exist' },
      project: { repo_path: '', github_repo: 'openai/codex' },
    });

    assert.equal(result.cwd, null);
    assert.match(result.error, /GitHub repo metadata is set to "openai\/codex"/);
    assert.match(result.error, /does not mount or clone that repository automatically/);
  });

  it('creates and updates AGENTS.md and CLAUDE.md with managed CCM context blocks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-project-context-'));
    const agentsPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# Local Instructions\n\nKeep responses short.\n', 'utf8');

    const firstPass = syncProjectInstructionFiles(tmpDir, {
      task: { id: 't1', title: 'Inspect structure', branch: 'main' },
      project: { name: 'CCM structure', repo_path: tmpDir, github_repo: 'owner/repo' },
    });
    assert.equal(firstPass.length, 2);

    const agentsText = fs.readFileSync(agentsPath, 'utf8');
    const claudeText = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    assert.match(agentsText, /# Local Instructions/);
    assert.match(agentsText, /project_github_url: https:\/\/github\.com\/owner\/repo/);
    assert.match(claudeText, /task_title: Inspect structure/);

    syncProjectInstructionFiles(tmpDir, {
      task: { id: 't1', title: 'Inspect structure', branch: 'main' },
      project: { name: 'CCM structure', repo_path: tmpDir, github_repo: 'owner/updated' },
    });
    const updatedAgentsText = fs.readFileSync(agentsPath, 'utf8');
    assert.equal((updatedAgentsText.match(/CCM Session Context \(Generated\)/g) || []).length, 1);
    assert.match(updatedAgentsText, /project_github_url: https:\/\/github\.com\/owner\/updated/);
  });
});

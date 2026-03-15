const fs = require('fs');
const path = require('path');

const CCM_CONTEXT_START = '<!-- CCM PROJECT CONTEXT START -->';
const CCM_CONTEXT_END = '<!-- CCM PROJECT CONTEXT END -->';

function clean(value) {
  return String(value || '').trim();
}

function normalizeGithubUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  if (/^https?:\/\/github\.com\//i.test(raw)) return raw;
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return `https://github.com/${raw}`;
  return raw;
}

function describeCandidate(raw) {
  const value = clean(raw);
  if (!value) return '';
  return path.resolve(value);
}

function resolveTaskWorkingDirectory({ task = null, project = null, requestedPath = '' } = {}) {
  const candidates = [
    requestedPath,
    task?.worktree_path,
    project?.repo_path,
  ];

  const tried = [];
  for (const candidate of candidates) {
    const resolved = describeCandidate(candidate);
    if (!resolved || tried.includes(resolved)) continue;
    tried.push(resolved);
    try {
      if (fs.statSync(resolved).isDirectory()) {
        return { cwd: resolved, error: null };
      }
    } catch {}
  }

  const githubRepo = clean(project?.github_repo);
  const details = tried.length > 0
    ? `Checked paths: ${tried.join(', ')}.`
    : 'No worktreePath or project.repo_path was set.';
  const guidance = githubRepo
    ? ` GitHub repo metadata is set to "${githubRepo}", but CCM does not mount or clone that repository automatically.`
    : '';
  return {
    cwd: null,
    error: `Task working directory is missing or invalid. ${details}${guidance} Set a real local checkout path before starting the task.`,
  };
}

function buildProjectContextBlock({ task = null, project = null, cwd = '' } = {}) {
  const githubRepo = clean(project?.github_repo);
  const githubUrl = normalizeGithubUrl(githubRepo);
  const lines = [
    CCM_CONTEXT_START,
    '## CCM Session Context (Generated)',
    '',
    'CCM injected the following project metadata for this workspace:',
    `- project_name: ${clean(project?.name) || '(not set)'}`,
    `- project_repo_path: ${clean(project?.repo_path) || clean(cwd) || '(not set)'}`,
    `- project_github_repo: ${githubRepo || '(not set)'}`,
    `- project_github_url: ${githubUrl || '(not set)'}`,
    `- task_id: ${clean(task?.id) || '(not set)'}`,
    `- task_title: ${clean(task?.title) || '(not set)'}`,
    `- task_branch: ${clean(task?.branch) || '(not set)'}`,
    '',
    'When working in this repository:',
    '- Treat the GitHub metadata above as the canonical remote reference when the local checkout is incomplete.',
    '- If the current workspace does not contain the expected repository files, say so explicitly before making assumptions.',
    '- Prefer the checked-out local files when they exist and match the task.',
    CCM_CONTEXT_END,
    '',
  ];
  return lines.join('\n');
}

function upsertManagedBlock(existing, block) {
  const source = typeof existing === 'string' ? existing : '';
  const managedPattern = new RegExp(
    `${CCM_CONTEXT_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CCM_CONTEXT_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    'm',
  );
  if (managedPattern.test(source)) {
    return source.replace(managedPattern, block);
  }
  if (!source.trim()) return block;
  return `${source.replace(/\s*$/, '')}\n\n${block}`;
}

function syncProjectInstructionFiles(cwd, context = {}) {
  const resolvedCwd = describeCandidate(cwd);
  if (!resolvedCwd) return [];
  const block = buildProjectContextBlock({ ...context, cwd: resolvedCwd });
  const changedFiles = [];

  for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
    const filePath = path.join(resolvedCwd, filename);
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const next = upsertManagedBlock(existing, block);
    if (next === existing) continue;
    fs.writeFileSync(filePath, next, 'utf8');
    changedFiles.push(filePath);
  }

  return changedFiles;
}

module.exports = {
  buildProjectContextBlock,
  normalizeGithubUrl,
  resolveTaskWorkingDirectory,
  syncProjectInstructionFiles,
  upsertManagedBlock,
};

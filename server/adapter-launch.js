const { execSync } = require('child_process');
const { buildClaudeEnv } = require('./claude-env');

function normalizeAdapterModel(adapter, model, aliases = {}) {
  const adapterName = String(adapter?.name || '').trim().toLowerCase();
  const rawModel = String(model || '').trim();
  if (!rawModel) return adapter?.defaultModel || '';
  return aliases[adapterName]?.[rawModel] || rawModel;
}

function isCommandAvailable(cmd) {
  const safe = String(cmd || '').trim();
  if (!safe || !/^[a-zA-Z0-9._-]+$/.test(safe)) return false;
  try {
    execSync(`bash -lc "command -v ${safe}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  const raw = String(value ?? '');
  return `'${raw.replace(/'/g, `'\"'\"'`)}'`;
}

function buildAdapterLaunchCommand(adapter, model, aliases = {}) {
  const args = [];
  const finalModel = normalizeAdapterModel(adapter, model, aliases);
  if (finalModel) args.push('--model', finalModel);
  if (Array.isArray(adapter?.defaultArgs) && adapter.defaultArgs.length > 0) {
    args.push(...adapter.defaultArgs);
  }
  return `${adapter?.cli || 'claude'} ${args.join(' ')}`.trim();
}

function buildAdapterEnvExports(adapter) {
  const exports = [];
  if (adapter?.cli === 'claude') {
    const env = buildClaudeEnv();
    exports.push(
      ['ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL],
      ['ANTHROPIC_AUTH_TOKEN', env.ANTHROPIC_AUTH_TOKEN],
    );
  }
  const lines = exports
    .filter(([, val]) => typeof val === 'string' && val.trim())
    .map(([key, val]) => `export ${key}=${shellQuote(val)}`);
  if (adapter?.cli === 'claude') {
    lines.push('unset ANTHROPIC_API_KEY APIKEY API_KEY');
  }
  return lines.join('; ');
}

function buildProjectContextEnvExports(task, project) {
  const exports = [
    ['CCM_TASK_ID', task?.id || ''],
    ['CCM_TASK_TITLE', task?.title || ''],
    ['CCM_TASK_BRANCH', task?.branch || ''],
    ['CCM_PROJECT_ID', project?.id || task?.project_id || ''],
    ['CCM_PROJECT_NAME', project?.name || ''],
    ['CCM_PROJECT_REPO_PATH', project?.repo_path || task?.worktree_path || ''],
    ['CCM_PROJECT_GITHUB_REPO', project?.github_repo || ''],
  ];
  return exports
    .filter(([, val]) => typeof val === 'string' && val.trim())
    .map(([key, val]) => `export ${key}=${shellQuote(val)}`)
    .join('; ');
}

function launchAdapterInSession(
  sessionName,
  { adapter, model, context, sessionEnvExports },
  { ptyManager, aliases = {} },
) {
  const adapterExports = buildAdapterEnvExports(adapter);
  ptyManager.sendInput(sessionName, 'export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LC_CTYPE=en_US.UTF-8\n');
  if (adapterExports) {
    ptyManager.sendInput(sessionName, `${adapterExports}\n`);
  }
  if (sessionEnvExports) {
    ptyManager.sendInput(sessionName, `${sessionEnvExports}\n`);
  }
  ptyManager.sendInput(sessionName, `${buildAdapterLaunchCommand(adapter, model, aliases)}\n`);
  if (adapter?.autoConfirm?.enabled) {
    const delayMs = Number(adapter?.autoConfirm?.delayMs) || 3000;
    setTimeout(() => {
      try {
        ptyManager.sendInput(sessionName, '\n');
      } catch {}
    }, delayMs);
  }
  if (context) {
    console.log(`launched adapter=${adapter?.name || 'claude'} session=${sessionName} (${context})`);
  }
}

module.exports = {
  normalizeAdapterModel,
  isCommandAvailable,
  shellQuote,
  buildAdapterLaunchCommand,
  buildAdapterEnvExports,
  buildProjectContextEnvExports,
  launchAdapterInSession,
};

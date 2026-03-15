const TASK_CHAT_HISTORY_LIMIT = 24;
const TASK_CHAT_HISTORY_TEXT_LIMIT = 120;

function compactText(input, maxLen = TASK_CHAT_HISTORY_TEXT_LIMIT) {
  const oneLine = String(input || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}...`;
}

function shouldIncludeHistoryEntry(entry) {
  const role = entry?.role;
  const text = String(entry?.text || '').trim();
  if (!text) return false;
  if (role !== 'user' && role !== 'assistant') return false;
  if (text.includes('You are in Task Session Chat. Strict scope rules:')) return false;
  if (text.includes('────────────────────────────────')) return false;
  return true;
}

function buildTaskScopedPrompt(task, project, userMessage, history = []) {
  const normalizedHistory = Array.isArray(history)
    ? history
      .filter((entry) => shouldIncludeHistoryEntry(entry))
      .slice(-TASK_CHAT_HISTORY_LIMIT)
      .map((entry) => ({
        role: entry.role === 'assistant' ? 'assistant' : 'user',
        text: compactText(entry.text),
      }))
    : [];

  const historyLines = normalizedHistory.length > 0
    ? [
      '',
      'Conversation history (oldest first):',
      ...normalizedHistory.map((entry, idx) => `${idx + 1}. [${entry.role}] ${entry.text}`),
    ]
    : ['', 'Conversation history: (empty)'];

  const lines = [
    'You are in Task Session Chat. Strict scope rules:',
    '1) Only discuss and act on the current task shown below.',
    '2) Do NOT query/list/summarize other tasks unless the user explicitly asks to compare across tasks.',
    '3) If user asks progress/status, report only current task progress.',
    '4) If information is missing for current task, ask a focused follow-up question.',
    '',
    'Current task context:',
    `- task_id: ${task?.id || ''}`,
    `- title: ${task?.title || ''}`,
    `- status: ${task?.status || ''}`,
    `- branch: ${task?.branch || ''}`,
    `- pty_session: ${task?.pty_session || ''}`,
    `- project_id: ${task?.project_id || ''}`,
    `- project_name: ${project?.name || ''}`,
    `- project_repo_path: ${project?.repo_path || ''}`,
    `- project_github_repo: ${project?.github_repo || ''}`,
    ...historyLines,
    '',
    'Current user message:',
    compactText(userMessage, 600),
  ];
  return lines.join('\n');
}

function buildTaskSessionPrompt(task, project, userMessage, bootstrap = false) {
  const lines = [];
  if (bootstrap) {
    lines.push(
      'You are in Task Session Chat. Strict scope rules:',
      '1) Only discuss and act on the current task shown below.',
      '2) Do NOT query/list/summarize other tasks unless explicitly requested.',
      '3) Keep answers concise and action-oriented.',
      '',
      'Current task context:',
      `- task_id: ${task?.id || ''}`,
      `- title: ${task?.title || ''}`,
      `- status: ${task?.status || ''}`,
      `- branch: ${task?.branch || ''}`,
      `- project_name: ${project?.name || ''}`,
      `- project_repo_path: ${project?.repo_path || ''}`,
      `- project_github_repo: ${project?.github_repo || ''}`,
      '',
    );
  } else {
    lines.push(
      `Task scope reminder: task_id=${task?.id || ''}, title="${task?.title || ''}", branch="${task?.branch || ''}", project="${project?.name || ''}", github_repo="${project?.github_repo || ''}".`,
      'Continue in the same task-scoped conversation context.',
      '',
    );
  }
  lines.push('Current user message:', compactText(userMessage, 1200));
  return lines.join('\n');
}

function isTaskStatusQuery(message) {
  const text = String(message || '').toLowerCase().trim();
  if (!text) return false;
  const patterns = [
    /进度/,
    /状态/,
    /什么进展/,
    /目前.*(怎么样|如何|进度)/,
    /还要多久/,
    /现在.*(干嘛|做什么)/,
    /\bprogress\b/,
    /\bstatus\b/,
    /\bupdate\b/,
    /\bwhat('?s| is)?\s+the\s+progress\b/,
  ];
  return patterns.some((re) => re.test(text));
}

function buildTaskStatusReply(task, project, hasActiveProcess) {
  const status = task?.status || 'unknown';
  const title = task?.title || '(untitled)';
  const branch = task?.branch || '(none)';
  const updatedAt = task?.updated_at || task?.created_at || '(unknown)';
  const projectName = project?.name || '(unknown)';
  const githubRepo = project?.github_repo || '(not set)';
  const running = hasActiveProcess ? 'yes' : 'no';
  return [
    'Current task progress summary:',
    `- title: ${title}`,
    `- status: ${status}`,
    `- running process attached: ${running}`,
    `- branch: ${branch}`,
    `- project: ${projectName}`,
    `- github repo: ${githubRepo}`,
    `- last updated: ${updatedAt}`,
    '',
    'If you want, I can continue with a concrete next action (for example: integrate ChatWindow, run build, or deploy).',
  ].join('\n');
}

module.exports = {
  compactText,
  shouldIncludeHistoryEntry,
  buildTaskScopedPrompt,
  buildTaskSessionPrompt,
  isTaskStatusQuery,
  buildTaskStatusReply,
};

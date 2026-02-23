const BASE_URL = process.env.MCP_BASE_URL || 'http://127.0.0.1:3000';
const REPO_PATH = process.env.MCP_REPO_PATH || '/Users/a1/Documents/claude-code-manager';
const PROJECT_NAME = `MCP Hot Session ${Date.now()}`;
const TASK_TITLE = `MCP Hot Task ${Date.now()}`;

async function http(path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${path}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

function parseSseFeed(text, onEvent) {
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n').filter((ln) => ln.startsWith('data: '));
    if (lines.length === 0) continue;
    const json = lines.map((ln) => ln.slice(6)).join('\n');
    try {
      onEvent(JSON.parse(json));
    } catch {
      // ignore malformed chunk
    }
  }
}

async function sendTaskMessage(taskId, message) {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/tasks/${taskId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`chat http ${res.status}`);
  const body = await res.text();

  let firstTextMs = null;
  let text = '';
  let done = false;
  let error = null;

  parseSseFeed(body, (evt) => {
    if (typeof evt.text === 'string') {
      text += evt.text;
      if (firstTextMs == null) firstTextMs = Date.now() - started;
    }
    if (evt?.error) error = evt.text || evt.error_code || 'unknown error';
    if (evt?.done) done = true;
  });

  if (!done) throw new Error('chat stream ended without done event');
  if (error) throw new Error(error);

  return {
    text: text.trim(),
    totalMs: Date.now() - started,
    firstTextMs: firstTextMs ?? (Date.now() - started),
  };
}

function summarizeLatency(results) {
  const first = results[0];
  const followups = results.slice(1);
  const avgFollowup = followups.reduce((s, r) => s + r.firstTextMs, 0) / followups.length;
  const maxFollowup = Math.max(...followups.map((r) => r.firstTextMs));
  return { first, avgFollowup, maxFollowup };
}

async function run() {
  let projectId = null;
  let taskId = null;

  try {
    const project = await http('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: PROJECT_NAME, repoPath: REPO_PATH, sshHost: '' }),
    });
    projectId = project.id;

    const task = await http('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: TASK_TITLE, projectId, branch: 'main', mode: 'claude' }),
    });
    taskId = task.id;

    await http(`/api/tasks/${taskId}/start`, {
      method: 'POST',
      body: JSON.stringify({ worktreePath: REPO_PATH, branch: 'main', model: 'claude-sonnet-4-5', mode: 'claude' }),
    });

    const memoryWord = `hot-${Date.now().toString(36)}`;
    const messages = [
      `请记住这个词，只回复 OK: ${memoryWord}`,
      '回复一个词: alpha',
      '回复一个词: beta',
      '回复一个词: gamma',
      '回复一个词: delta',
      '回复一个词: epsilon',
      '回复一个词: zeta',
      '回复一个词: eta',
      '回复一个词: theta',
      '你第一条让我记住的词是什么？只回复那个词',
    ];

    const results = [];
    for (let i = 0; i < messages.length; i += 1) {
      const out = await sendTaskMessage(taskId, messages[i]);
      results.push(out);
      console.log(`turn ${String(i + 1).padStart(2, '0')} | ttfb=${out.firstTextMs}ms total=${out.totalMs}ms | ${out.text.slice(0, 80)}`);
    }

    const recall = results.at(-1)?.text || '';
    if (!recall.includes(memoryWord)) {
      throw new Error(`context lost: expected recall to include ${memoryWord}, got: ${recall}`);
    }

    const historyA = await http(`/api/tasks/${taskId}/chat/history`);
    if (!Array.isArray(historyA?.messages) || historyA.messages.length < 20) {
      throw new Error(`history not persisted enough, count=${historyA?.messages?.length || 0}`);
    }

    // Simulate another client after refresh: fetch history + ask recall again.
    const historyB = await http(`/api/tasks/${taskId}/chat/history`);
    if (!historyB.messages.some((m) => String(m.text || '').includes(memoryWord))) {
      throw new Error('cross-client history read failed');
    }
    const recallAgain = await sendTaskMessage(taskId, '再确认一次：第一条让我记住的词是什么？只回复词');
    if (!recallAgain.text.includes(memoryWord)) {
      throw new Error(`cross-client context lost: ${recallAgain.text}`);
    }

    const latency = summarizeLatency(results);
    console.log(`latency first_ttfb=${latency.first.firstTextMs}ms avg_followup_ttfb=${Math.round(latency.avgFollowup)}ms max_followup_ttfb=${latency.maxFollowup}ms`);

    if (latency.maxFollowup > 30000) {
      throw new Error(`follow-up latency too high: max ${latency.maxFollowup}ms`);
    }

    console.log('mcp-task-hot-session: PASS');
  } finally {
    if (taskId) {
      try { await http(`/api/tasks/${taskId}`, { method: 'DELETE' }); } catch {}
    }
    if (projectId) {
      try { await http(`/api/projects/${projectId}`, { method: 'DELETE' }); } catch {}
    }
  }
}

run().catch((err) => {
  console.error('mcp-task-hot-session: FAIL');
  console.error(err?.stack || err);
  process.exit(1);
});

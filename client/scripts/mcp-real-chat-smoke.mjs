import { chromium } from 'playwright';

const BASE_URL = process.env.MCP_BASE_URL || 'http://43.138.129.193:3000';
const PROJECT_NAME = `MCP Real Project ${Date.now()}`;
const TASK_TITLE = `MCP Real Task ${Date.now()}`;
const REPO_PATH = process.env.MCP_REPO_PATH || '/opt/claude-code-manager';

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

async function sendByComposer(page, text, useLast = false) {
  const editor = useLast ? page.locator('[contenteditable="true"]').last() : page.locator('[contenteditable="true"]').first();
  const sendBtn = useLast ? page.locator('button.cs-button--send').last() : page.locator('button.cs-button--send').first();
  await editor.click();
  await page.keyboard.type(text);
  await sendBtn.click();
}

async function run() {
  let projectId = null;
  let taskId = null;

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
    body: JSON.stringify({
      worktreePath: REPO_PATH,
      branch: 'main',
      model: 'claude-sonnet-4-5',
      mode: 'claude',
    }),
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.getByText('Claude Code Manager').first().waitFor({ timeout: 15000 });

    await page.getByRole('button', { name: new RegExp(PROJECT_NAME) }).first().click();
    const taskCard = page.locator('article', { hasText: TASK_TITLE }).first();
    await taskCard.waitFor({ timeout: 15000 });
    await taskCard.getByRole('button', { name: 'Chat' }).click();

    await page.getByText('Task Session Chat').waitFor({ timeout: 15000 });
    const taskReq = page.waitForRequest(
      (req) => req.url().includes('/api/tasks/') && req.url().includes('/chat') && req.method() === 'POST',
      { timeout: 15000 },
    );
    await sendByComposer(page, '现在什么进度', true);
    await taskReq;

    await page.getByText('Current task progress summary:').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);

    const networkErrCount = await page.getByText(/Error:\s*network error/i).count();
    if (networkErrCount > 0) {
      throw new Error(`found ${networkErrCount} network error messages in sub-task chat`);
    }

    if (pageErrors.length > 0) {
      throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    }

    console.log('mcp-real-chat-smoke: PASS');
  } finally {
    await context.close();
    await browser.close();
    if (taskId) {
      try { await http(`/api/tasks/${taskId}`, { method: 'DELETE' }); } catch {}
    }
    if (projectId) {
      try { await http(`/api/projects/${projectId}`, { method: 'DELETE' }); } catch {}
    }
  }
}

run().catch((err) => {
  console.error('mcp-real-chat-smoke: FAIL');
  console.error(err?.stack || err);
  process.exit(1);
});

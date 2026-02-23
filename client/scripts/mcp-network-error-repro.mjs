import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 4173;
const BASE_URL = `http://${HOST}:${PORT}`;

function startVite() {
  const child = spawn('npm', ['run', 'dev', '--', '--host', HOST, '--port', String(PORT), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'pipe',
  });
  child.stdout.on('data', (buf) => process.stdout.write(buf));
  child.stderr.on('data', (buf) => process.stderr.write(buf));
  return child;
}

async function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await delay(400);
  }
  throw new Error(`Timed out waiting for dev server: ${url}`);
}

async function sendByComposer(page, text, useLast = false) {
  const editor = useLast ? page.locator('[contenteditable="true"]').last() : page.locator('[contenteditable="true"]').first();
  const sendBtn = useLast ? page.locator('button.cs-button--send').last() : page.locator('button.cs-button--send').first();
  await editor.click();
  await page.keyboard.type(text);
  await sendBtn.click();
}

function createSseBody(text) {
  return [
    'data: {"ready":true}\n\n',
    `data: ${JSON.stringify({ text })}\n\n`,
    'data: {"done":true,"code":0,"signal":null}\n\n',
  ].join('');
}

async function installRoutes(context, state) {
  await context.route('**/api/projects', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'p1', name: 'Network Error Project', repo_path: '/tmp/repo' }]),
    });
  });

  await context.route('**/api/tasks?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 't1',
        title: 'Network Error Task',
        status: 'in_progress',
        project_id: 'p1',
        branch: 'main',
        tmux_session: 'claude-task-t1',
        worktree_path: '/tmp/repo',
      }]),
    });
  });

  await context.route('**/api/tasks/t1/chat/history', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: state.history }),
    });
  });

  await context.route('**/api/tasks/t1/chat', async (route) => {
    state.chatCalls += 1;
    const payload = JSON.parse(route.request().postData() || '{}');
    const msg = String(payload.message || '').trim();
    state.history.push({ role: 'user', text: msg, created_at: new Date().toISOString() });

    if (state.chatCalls === 1) {
      await route.fulfill({
        status: 502,
        contentType: 'text/plain; charset=utf-8',
        body: 'network error',
      });
      return;
    }

    state.history.push({ role: 'assistant', text: 'ok after retry', created_at: new Date().toISOString() });
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      body: createSseBody('ok after retry'),
    });
  });

  await context.route('**/api/agent', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      body: createSseBody('ack'),
    });
  });
}

async function run() {
  const vite = startVite();
  let browser;
  const state = { history: [], chatCalls: 0 };

  try {
    await waitForServer(BASE_URL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await installRoutes(context, state);
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Network Error Project' }).click();
    const card = page.locator('article', { hasText: 'Network Error Task' }).first();
    await card.waitFor({ timeout: 10000 });
    await card.getByRole('button', { name: 'Chat' }).click();
    await page.getByText('Task Session Chat').waitFor({ timeout: 10000 });

    await sendByComposer(page, 'first try', true);
    await page.getByText('Error: network error').last().waitFor({ timeout: 10000 });

    await sendByComposer(page, 'second try', true);
    await page.getByText('ok after retry').last().waitFor({ timeout: 10000 });

    await context.close();
    console.log('mcp-network-error-repro: PASS (Error: network error reproduced)');
  } finally {
    if (browser) await browser.close();
    if (vite && !vite.killed) {
      vite.kill('SIGTERM');
      await delay(200);
      if (!vite.killed) vite.kill('SIGKILL');
    }
  }
}

run().catch((err) => {
  console.error('mcp-network-error-repro: FAIL');
  console.error(err?.stack || err);
  process.exit(1);
});

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

function stripWord(msg) {
  const m = msg.match(/记住这个单词[:：]\s*([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function includesRecall(msg) {
  return /记住的单词/.test(msg);
}

async function installMockRoutes(context, state) {
  await context.route('**/api/projects', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'p1', name: 'Persistence Project', repo_path: '/tmp/repo' }]),
    });
  });

  await context.route('**/api/tasks?*', async (route) => {
    const tasks = state.deleted
      ? []
      : [{
          id: 't1',
          title: 'Persistent Task',
          status: 'in_progress',
          project_id: 'p1',
          branch: 'main',
          tmux_session: 'claude-task-t1',
          worktree_path: '/tmp/repo',
        }];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tasks),
    });
  });

  await context.route('**/api/tasks/t1/chat/history', async (route) => {
    const method = route.request().method();
    if (method === 'DELETE') {
      state.history = [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: state.history }),
    });
  });

  await context.route('**/api/tasks/t1/chat', async (route) => {
    const payload = JSON.parse(route.request().postData() || '{}');
    const msg = String(payload.message || '').trim();
    state.history.push({ role: 'user', text: msg, created_at: new Date().toISOString() });
    if (stripWord(msg)) state.memoryWord = stripWord(msg);

    let reply = 'OK';
    if (includesRecall(msg)) reply = state.memoryWord || '(none)';
    if (/现在什么进度/.test(msg)) reply = state.runtimeAlive ? 'running' : 'stopped';

    state.history.push({ role: 'assistant', text: reply, created_at: new Date().toISOString() });
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      body: createSseBody(reply),
    });
  });

  await context.route('**/api/tasks/t1/stop', async (route) => {
    state.stopCalls += 1;
    state.runtimeAlive = false;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await context.route('**/api/tasks/t1', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }
    state.deleteCalls += 1;
    state.runtimeAlive = false;
    state.deleted = true;
    state.history = [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await context.route('**/api/agent', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      body: createSseBody('ack'),
    });
  });
}

async function openTaskChat(page) {
  await page.getByRole('button', { name: 'Persistence Project' }).click();
  const card = page.locator('article', { hasText: 'Persistent Task' }).first();
  await card.waitFor({ timeout: 10000 });
  await card.getByRole('button', { name: 'Chat' }).click();
  await page.getByText('Task Session Chat').waitFor({ timeout: 10000 });
}

async function run() {
  const vite = startVite();
  let browser;
  const state = {
    history: [],
    memoryWord: null,
    runtimeAlive: true,
    stopCalls: 0,
    deleteCalls: 0,
    deleted: false,
  };

  try {
    await waitForServer(BASE_URL);
    browser = await chromium.launch({ headless: true });

    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await installMockRoutes(contextA, state);
    const pageA = await contextA.newPage();
    pageA.on('dialog', async (dialog) => {
      await dialog.accept();
    });
    await pageA.goto(BASE_URL, { waitUntil: 'networkidle' });
    await pageA.getByText('Claude Code Manager').first().waitFor({ timeout: 10000 });
    await openTaskChat(pageA);

    await sendByComposer(pageA, '记住这个单词: banana', true);
    await pageA.getByText('OK').last().waitFor({ timeout: 10000 });

    // case 1: refresh after history persisted
    await pageA.reload({ waitUntil: 'networkidle' });
    await openTaskChat(pageA);
    await pageA.getByText('记住这个单词: banana').last().waitFor({ timeout: 10000 });
    await pageA.getByText('OK').last().waitFor({ timeout: 10000 });
    await sendByComposer(pageA, '我刚刚让你记住的单词是什么？', true);
    await pageA.getByText('banana').last().waitFor({ timeout: 10000 });

    // case 3: multi-end shared history/context
    const contextB = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await installMockRoutes(contextB, state);
    const pageB = await contextB.newPage();
    await pageB.goto(BASE_URL, { waitUntil: 'networkidle' });
    await openTaskChat(pageB);
    await pageB.getByText('记住这个单词: banana').last().waitFor({ timeout: 10000 });
    await sendByComposer(pageB, '我刚刚让你记住的单词是什么？', true);
    await pageB.getByText('banana').last().waitFor({ timeout: 10000 });
    await contextB.close();

    // case 2: runtime stays alive until delete
    await pageA.getByRole('button', { name: 'Close' }).click();
    await pageA.getByText('Task Session Chat').waitFor({ state: 'hidden', timeout: 10000 });
    if (!state.runtimeAlive) throw new Error('runtime should stay alive when only closing task chat');
    await pageA.getByRole('button', { name: 'Delete' }).first().click();
    await pageA.getByRole('button', { name: 'Delete' }).first().waitFor({ state: 'hidden', timeout: 15000 });
    if (state.deleteCalls !== 1) throw new Error(`expected deleteCalls=1, got ${state.deleteCalls}`);
    if (state.runtimeAlive) throw new Error('runtime should stop after task delete');
    if (state.stopCalls !== 0) throw new Error(`stop endpoint should not be auto-called on close, got ${state.stopCalls}`);

    await contextA.close();
    console.log('mcp-task-persistence: PASS');
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
  console.error('mcp-task-persistence: FAIL');
  console.error(err?.stack || err);
  process.exit(1);
});

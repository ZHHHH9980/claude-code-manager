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

async function run() {
  const vite = startVite();
  let browser;

  try {
    await waitForServer(BASE_URL);
    browser = await chromium.launch({ headless: true });

    async function runScenario(name, transition) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      let taskListFetchCount = 0;

      await page.route('**/api/projects', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'p1', name: 'MCP Test Project', repo_path: '/tmp/mcp-repo' },
          ]),
        });
      });

      await page.route('**/api/tasks?*', async (route) => {
        taskListFetchCount += 1;
        let tasksPayload;
        if (taskListFetchCount <= 1) {
          tasksPayload = [
            {
              id: 't1',
              title: 'Task modal auto close',
              status: 'in_progress',
              project_id: 'p1',
              branch: 'main',
              tmux_session: 'session-t1',
            },
          ];
        } else if (transition === 'deleted') {
          tasksPayload = [];
        } else {
          tasksPayload = [
            {
              id: 't1',
              title: 'Task modal auto close',
              status: transition,
              project_id: 'p1',
              branch: 'main',
              tmux_session: 'session-t1',
            },
          ];
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(tasksPayload),
        });
      });

      await page.route('**/api/tasks/t1/chat', async (route) => {
        const sse = [
          'data: {"ready":true}\n\n',
          `data: {"text":"Task transitioned to ${transition}."}\n\n`,
          'data: {"done":true}\n\n',
        ].join('');
        await route.fulfill({
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
          },
          body: sse,
        });
      });

      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      await page.getByText('Claude Code Manager').first().waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'MCP Test Project' }).click();
      await page.getByText('Task modal auto close').first().waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Chat' }).click();
      await page.getByText('Task Session Chat').waitFor({ timeout: 10000 });
      const input = page.getByPlaceholder('Send message to this sub task...');
      await input.fill('结束当前任务');
      const chatReq = page.waitForRequest((req) => req.url().includes('/api/tasks/t1/chat') && req.method() === 'POST', { timeout: 10000 });
      await input.press('Enter');
      await chatReq;

      if (transition === 'in_progress') {
        await page.getByText('Task Session Chat').waitFor({ state: 'visible', timeout: 10000 });
      } else {
        await page.getByText('Task Session Chat').waitFor({ state: 'hidden', timeout: 10000 });
      }

      await context.close();
      console.log(`mcp-task-modal-close: ${name} PASS`);
    }

    await runScenario('done_closes', 'done');
    await runScenario('interrupted_closes', 'interrupted');
    await runScenario('deleted_closes', 'deleted');
    await runScenario('in_progress_stays_open', 'in_progress');
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
  console.error('mcp-task-modal-close: FAIL');
  console.error(err?.stack || err);
  process.exit(1);
});

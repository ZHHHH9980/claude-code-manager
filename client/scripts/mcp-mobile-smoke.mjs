import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from 'playwright';

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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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

    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktop.goto(BASE_URL, { waitUntil: 'networkidle' });
    await desktop.getByText('Claude Code Manager').first().waitFor({ timeout: 10000 });

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobile = await mobileContext.newPage();
    mobile.on('pageerror', (err) => console.error('[mobile pageerror]', err.message));
    await mobile.goto(BASE_URL, { waitUntil: 'networkidle' });
    await mobile.getByRole('button', { name: 'Projects' }).waitFor({ timeout: 10000 });
    await mobile.getByRole('button', { name: 'Tasks' }).waitFor({ timeout: 10000 });
    await mobile.getByRole('button', { name: 'Chat' }).waitFor({ timeout: 10000 });

    await mobileContext.close();
    await desktop.close();

    console.log('mcp-mobile-smoke: PASS');
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
  console.error('mcp-mobile-smoke: FAIL');
  console.error(err?.stack || err);
  process.exit(1);
});

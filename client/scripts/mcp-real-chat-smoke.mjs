import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:3300';
const PROJECT_NAME = 'UI Smoke Project';
const TASK_TITLE = 'UI Smoke Task';

async function sendByComposer(page, text, useLast = false) {
  const editor = useLast ? page.locator('[contenteditable="true"]').last() : page.locator('[contenteditable="true"]').first();
  const sendBtn = useLast ? page.locator('button.cs-button--send').last() : page.locator('button.cs-button--send').first();
  await editor.click();
  await page.keyboard.type(text);
  await sendBtn.click();
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.getByText('Claude Code Manager').first().waitFor({ timeout: 15000 });

    const mainReq = page.waitForRequest(
      (req) => req.url().includes('/api/agent') && req.method() === 'POST',
      { timeout: 15000 },
    );
    await sendByComposer(page, 'say hello in one short sentence', false);
    await mainReq;

    await page.getByRole('button', { name: new RegExp(PROJECT_NAME) }).first().click();
    const taskCard = page.locator('article', { hasText: TASK_TITLE }).first();
    await taskCard.waitFor({ timeout: 15000 });
    await taskCard.getByRole('button', { name: 'Chat' }).click();

    await page.getByText('Task Session Chat').waitFor({ timeout: 15000 });
    const taskReq = page.waitForRequest(
      (req) => req.url().includes('/api/tasks/') && req.url().includes('/chat') && req.method() === 'POST',
      { timeout: 15000 },
    );
    await sendByComposer(page, 'report current task status briefly', true);
    await taskReq;

    await page.waitForTimeout(2000);

    if (pageErrors.length > 0) {
      throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    }

    console.log('mcp-real-chat-smoke: PASS');
  } finally {
    await context.close();
    await browser.close();
  }
}

run().catch((err) => {
  console.error('mcp-real-chat-smoke: FAIL');
  console.error(err?.stack || err);
  process.exit(1);
});

/**
 * scripts/capture-screenshots.ts
 *
 * Captures all n8n UI screenshots referenced by docs/manual-test.md.
 * Screenshots are saved to docs/screenshots/.
 *
 * Usage:
 *   npm run screenshots
 *
 * How it works:
 *   1. Writes a docker-compose.override.yml that disables n8n basic-auth
 *      (required because the n8n 2.6.4 body-parser bug rejects POST /rest/login
 *      when N8N_BASIC_AUTH_ACTIVE=true).
 *   2. Restarts only the n8n container with the override applied.
 *   3. Navigates through the full UI with a headless Chromium browser.
 *   4. Saves screenshots to docs/screenshots/.
 *   5. Removes the override file and restores n8n with basic-auth re-enabled.
 *
 * Prerequisites: all Docker services must be running.
 */

import { test, expect, chromium, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'fs';
import * as path from 'path';

const ROOT        = path.resolve(__dirname, '..');
const SCREENSHOTS = path.join(ROOT, 'docs', 'screenshots');
const OVERRIDE    = path.join(ROOT, 'docker-compose.override.yml');
const N8N         = 'http://localhost:5678';

// Load .env from project root if it exists (fallback to environment variables)
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && !key.startsWith('#') && rest.length) {
      process.env[key.trim()] ??= rest.join('=').trim();
    }
  }
}

const EMAIL = process.env.N8N_EMAIL ?? (() => { throw new Error('Set N8N_EMAIL in .env or environment'); })();
const PASS  = process.env.N8N_PASS  ?? (() => { throw new Error('Set N8N_PASS in .env or environment');  })();
const CDC_ID      = 'sLFyTfSNzFIiVC9t';
const AI_ID      = '5cf0evFgopkFXM7q';
const RESET_ID   = 'JItVx5wVu0WTIvkA';

// ── helpers ───────────────────────────────────────────────────────────────────

function compose(...args: string[]) {
  execFileSync('docker', ['compose', '-f', path.join(ROOT, 'docker-compose.yml'), ...args],
    { cwd: ROOT, stdio: 'pipe' });
}

async function snap(page: Page, filename: string) {
  const file = path.join(SCREENSHOTS, filename);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  Saved: docs/screenshots/${filename}`);
}

async function waitForN8N(maxMs = 30_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${N8N}/healthz`);
      if (r.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1_000));
  }
  throw new Error('n8n did not become ready within 30 s');
}

// ── main test ─────────────────────────────────────────────────────────────────

test('Capture all n8n UI screenshots', async () => {
  mkdirSync(SCREENSHOTS, { recursive: true });

  // ── Step 1: Disable basic-auth so the login form works ────────────────────
  console.log('\n1. Disabling basic-auth on n8n for screenshot session...');
  writeFileSync(OVERRIDE, [
    'services:',
    '  n8n:',
    '    environment:',
    '      N8N_BASIC_AUTH_ACTIVE: "false"',
    '',
  ].join('\n'));

  compose('up', '-d', '--no-deps', 'n8n');
  console.log('   Waiting for n8n to restart...');
  await new Promise(r => setTimeout(r, 6_000));
  await waitForN8N();
  console.log('   n8n is ready (basic-auth disabled).');

  // ── Step 2: Launch browser ─────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // ── 01: Sign-in page ──────────────────────────────────────────────────────
    console.log('\n2. Capturing sign-in page...');
    await page.goto(N8N, { waitUntil: 'networkidle' });
    await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
    await snap(page, '01-signin-page.png');

    // ── 02: Credentials filled ────────────────────────────────────────────────
    console.log('3. Filling credentials...');
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASS);
    await snap(page, '02-signin-credentials-filled.png');

    // ── 03: Log in → Workflow dashboard ──────────────────────────────────────
    console.log('4. Logging in...');
    await page.locator('input[type="password"]').press('Enter');
    await page.waitForURL(url => !url.toString().includes('/signin'), { timeout: 15_000 });

    // Dismiss any onboarding dialogs
    await page.waitForTimeout(2_000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    await page.goto(`${N8N}/home/workflows`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);
    await snap(page, '03-workflow-dashboard.png');

    // ── 04: Zoom active badge area ────────────────────────────────────────────
    console.log('5. Capturing workflow list active badges...');
    await snap(page, '04-workflow-list-active-badges.png');

    // ── 05: CDC Workflow editor ───────────────────────────────────────────────
    console.log('6. Opening CDC workflow editor...');
    await page.goto(`${N8N}/workflow/${CDC_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '05-cdc-workflow-canvas.png');

    // ── 06: CDC Executions list ───────────────────────────────────────────────
    console.log('7. Opening CDC execution history...');
    await page.goto(`${N8N}/workflow/${CDC_ID}/executions`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '06-cdc-executions-list.png');

    // Click the first execution if any exist
    const firstExec = page.locator('[data-test-id="execution-list-item"], .execution-list-item, tr[class*="execution"]').first();
    if (await firstExec.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await firstExec.click();
      await page.waitForTimeout(3_000);
      await snap(page, '07-cdc-execution-detail.png');
    } else {
      console.log('   No CDC executions yet — triggering one...');
      execFileSync('kubectl', ['--context', 'kind-k8s-ai', 'create', 'namespace', 'screenshot-ns',
                              '--dry-run=client', '-o', 'yaml'], { stdio: 'pipe' });
      execFileSync('kubectl', ['--context', 'kind-k8s-ai', 'create', 'namespace', 'screenshot-ns'],
        { stdio: 'pipe' }).toString();
      await new Promise(r => setTimeout(r, 8_000));
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(2_000);
      await snap(page, '06-cdc-executions-list.png');
      await page.locator('[data-test-id="execution-list-item"], tr[class*="execution"]').first()
        .click().catch(() => {});
      await page.waitForTimeout(2_000);
      await snap(page, '07-cdc-execution-detail.png');
      execFileSync('kubectl', ['--context', 'kind-k8s-ai', 'delete', 'namespace', 'screenshot-ns',
                              '--ignore-not-found', '--wait=false'], { stdio: 'pipe' });
    }

    // ── 08: AI Workflow editor ────────────────────────────────────────────────
    console.log('8. Opening AI workflow editor...');
    await page.goto(`${N8N}/workflow/${AI_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '08-ai-workflow-canvas.png');

    // ── 09: AI chat — use the public webhook chat UI ─────────────────────────
    console.log('9. Opening public AI chat interface...');
    // The public chat is at /webhook/k8s-ai-chat/chat (no n8n login required)
    await page.goto(`${N8N}/webhook/k8s-ai-chat/chat`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '09-ai-chat-public.png');

    // Find the chat input on the public chat page
    const chatInput = page.locator(
      'textarea, input[type="text"]'
    ).first();
    if (await chatInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await chatInput.fill('List all namespaces in the Kubernetes cluster');
      await snap(page, '10-ai-chat-query-typed.png');
      await chatInput.press('Enter');
      await page.waitForTimeout(20_000); // LLM takes ~10–15 s
      await snap(page, '11-ai-chat-response.png');
    } else {
      // Fall back to AI workflow editor with active header
      await page.goto(`${N8N}/workflow/${AI_ID}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(3_000);
      await snap(page, '09-ai-workflow-active-header.png');
    }

    // ── 10: AI Executions list ────────────────────────────────────────────────
    console.log('10. Opening AI execution history...');
    await page.goto(`${N8N}/workflow/${AI_ID}/executions`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '12-ai-executions-list.png');

    // Click first AI execution detail
    const firstAiExec = page.locator('[data-test-id="execution-list-item"], tr[class*="execution"]').first();
    if (await firstAiExec.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await firstAiExec.click();
      await page.waitForTimeout(3_000);
      await snap(page, '13-ai-execution-detail.png');
    }

    // ── 11: Reset Workflow editor ─────────────────────────────────────────────
    console.log('11. Opening Reset workflow editor...');
    await page.goto(`${N8N}/workflow/${RESET_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '15-reset-workflow-canvas.png');

    // ── 12: Reset Workflow executions list ────────────────────────────────────
    console.log('12. Opening Reset workflow execution history...');
    await page.goto(`${N8N}/workflow/${RESET_ID}/executions`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '16-reset-workflow-executions.png');

    // ── 13: Settings page ─────────────────────────────────────────────────────
    console.log('13. Capturing settings page...');
    await page.goto(`${N8N}/settings/api`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);
    await snap(page, '17-settings-api.png');

  } finally {
    await browser.close();

    // ── Step 3: Restore basic-auth ─────────────────────────────────────────────
    console.log('\n12. Restoring basic-auth on n8n...');
    if (existsSync(OVERRIDE)) unlinkSync(OVERRIDE);
    compose('up', '-d', '--no-deps', 'n8n');
    console.log('   n8n restarting with basic-auth restored...');
    await new Promise(r => setTimeout(r, 4_000));
    console.log('   Done. Basic-auth is re-enabled.');
  }

  console.log(`\nAll screenshots saved to: docs/screenshots/`);
  const files = require('fs').readdirSync(SCREENSHOTS).filter((f: string) => f.endsWith('.png'));
  files.forEach((f: string) => console.log(`  docs/screenshots/${f}`));
});

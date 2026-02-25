/**
 * scripts/capture-screenshots.ts
 *
 * Captures all n8n UI screenshots for docs and the Medium article.
 * Saves to docs/screenshots/.
 *
 * Two categories:
 *   A) Overview — dashboard, flow canvases, executions, chat
 *   B) Per-node config panels — every node in every flow, NDV panel open
 *
 * DOM facts discovered via inspection:
 *   - Canvas nodes: .vue-flow__node[data-id="<nodeId>"]
 *   - Node inner wrapper: [data-test-id="canvas-node"]
 *   - Node Details View (config panel): [data-test-id="ndv"]
 *   - Single click on a node opens the NDV panel in n8n 2.x
 */

import { test, chromium, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'fs';
import * as path from 'path';

const ROOT        = path.resolve(__dirname, '..');
const SCREENSHOTS = path.join(ROOT, 'docs', 'screenshots');
const OVERRIDE    = path.join(ROOT, 'docker-compose.override.yml');
const N8N         = 'http://localhost:5678';

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && !key.startsWith('#') && rest.length) {
      process.env[key.trim()] ??= rest.join('=').trim();
    }
  }
}

const EMAIL    = process.env.N8N_EMAIL ?? (() => { throw new Error('Set N8N_EMAIL in .env'); })();
const PASS     = process.env.N8N_PASS  ?? (() => { throw new Error('Set N8N_PASS in .env');  })();
const CDC_ID   = 'sLFyTfSNzFIiVC9t';
const AI_ID    = '5cf0evFgopkFXM7q';
const RESET_ID = 'JItVx5wVu0WTIvkA';

// ── helpers ───────────────────────────────────────────────────────────────────

function compose(...args: string[]) {
  execFileSync('docker', ['compose', '-f', path.join(ROOT, 'docker-compose.yml'), ...args],
    { cwd: ROOT, stdio: 'pipe' });
}

async function snap(page: Page, filename: string) {
  await page.screenshot({ path: path.join(SCREENSHOTS, filename), fullPage: false });
  console.log(`    ✓ ${filename}`);
}

async function waitForN8N(maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${N8N}/healthz`)).ok) return; } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 1_000));
  }
  throw new Error('n8n not ready within 30s');
}

/**
 * Click a canvas node by its workflow JSON id (the data-id attribute on
 * .vue-flow__node), wait for the NDV config panel to open, screenshot, close.
 *
 * n8n DOM: .vue-flow__node[data-id="<nodeId>"] → single click → [data-test-id="ndv"]
 */
async function snapNode(page: Page, nodeId: string, label: string, filename: string) {
  console.log(`  → node: "${label}" (${nodeId})`);

  // Ensure any previously open panel is closed
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`);

  try {
    await node.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    console.log(`    ✗ node "${nodeId}" not found on canvas — skipping`);
    return;
  }

  // Single click opens the NDV panel in n8n 2.x
  await node.click({ force: true });
  await page.waitForTimeout(600);

  // If panel did not open, try double-click
  const ndv = page.locator('[data-test-id="ndv"]');
  if (!await ndv.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await node.dblclick({ force: true });
    await page.waitForTimeout(800);
  }

  // Check result
  const opened = await ndv.isVisible({ timeout: 1_500 }).catch(() => false);
  if (!opened) {
    console.log(`    ✗ panel did not open for "${label}" — snapping current state`);
  }

  await snap(page, filename);

  // Close the panel
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// ── main ──────────────────────────────────────────────────────────────────────

test('Capture all n8n UI screenshots', async () => {
  mkdirSync(SCREENSHOTS, { recursive: true });

  // ── Disable basic-auth so login works (n8n 2.6.4 body-parser bug) ──────────
  console.log('\n[setup] Disabling basic-auth for screenshot session...');
  writeFileSync(OVERRIDE,
    'services:\n  n8n:\n    environment:\n      N8N_BASIC_AUTH_ACTIVE: "false"\n');
  compose('up', '-d', '--no-deps', 'n8n');
  await new Promise(r => setTimeout(r, 7_000));
  await waitForN8N();
  console.log('[setup] n8n ready.\n');

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // ── Sign-in ────────────────────────────────────────────────────────────────
    console.log('[01] Sign-in page');
    await page.goto(N8N, { waitUntil: 'networkidle' });
    await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
    await snap(page, '01-signin-page.png');

    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASS);
    await snap(page, '02-signin-credentials-filled.png');

    await page.locator('input[type="password"]').press('Enter');
    await page.waitForURL(u => !u.toString().includes('/signin'), { timeout: 15_000 });
    await page.waitForTimeout(2_000);
    await snap(page, '02b-post-signin-landing.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // ── Dashboard ──────────────────────────────────────────────────────────────
    console.log('[03] Workflow dashboard');
    await page.goto(`${N8N}/home/workflows`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);
    await snap(page, '03-workflow-dashboard.png');
    await snap(page, '04-workflow-list-active-badges.png');

    // ── Credentials page ────────────────────────────────────────────────────
    console.log('\n[Creds] Credentials page...');
    await page.goto(`${N8N}/credentials`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);
    await snap(page, 'cred-01-credentials-list.png');

    // ── Workflow creation process ────────────────────────────────────────────
    console.log('\n[Create] Blank workflow canvas...');
    await page.goto(`${N8N}/workflow/new`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, 'create-01-blank-canvas.png');

    // Open node creator — Tab is the canonical shortcut in n8n 2.x
    console.log('[Create] Opening node creator...');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1_500);

    // Verify node creator opened; if not, try clicking the canvas "+" button
    const nodeCreator = page.locator('[data-test-id="node-creator"]');
    if (!await nodeCreator.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const addBtn = page.locator('[data-test-id="canvas-add-button"], button[aria-label*="add"], .add-node-button').first();
      if (await addBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await addBtn.click();
        await page.waitForTimeout(1_500);
      }
    }
    await snap(page, 'create-02-node-creator-open.png');

    // Search for each node type used in our flows
    const searches: Array<[string, string]> = [
      ['kafka trigger',   'create-03-search-kafka-trigger.png'],
      ['http request',    'create-04-search-http-request.png'],
      ['code',            'create-05-search-code.png'],
      ['if',              'create-06-search-if.png'],
      ['webhook',         'create-07-search-webhook.png'],
      ['chat trigger',    'create-08-search-chat-trigger.png'],
    ];

    // Try multiple selector strategies for the search input
    const searchSel = [
      '[data-test-id="node-creator"] input[type="text"]',
      '[data-test-id="node-creator-search-bar"] input',
      '.node-creator input[type="text"]',
      'input[placeholder*="Search"]',
      'input[placeholder*="search"]',
    ].join(', ');
    const searchInput = page.locator(searchSel).first();

    if (await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      for (const [term, filename] of searches) {
        await searchInput.fill('');
        await searchInput.fill(term);
        await page.waitForTimeout(800);
        await snap(page, filename);
      }
    } else {
      console.log('    ✗ node-creator search input not found — skipping search screenshots');
      await snap(page, 'create-03-search-kafka-trigger.png'); // at least grab state
    }

    // Leave canvas without saving — navigate away
    await page.goto(`${N8N}/home/workflows`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1_500);

    // Dismiss "unsaved changes" dialog if it appears
    const discardBtn = page.locator('button:has-text("Discard"), button:has-text("Leave"), button:has-text("Don\'t save")').first();
    if (await discardBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await discardBtn.click();
      await page.waitForTimeout(1_000);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CDC_K8s_Flow
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[CDC] Opening workflow canvas...');
    await page.goto(`${N8N}/workflow/${CDC_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '05-cdc-workflow-canvas.png');

    console.log('[CDC] Capturing node panels...');
    await snapNode(page, 'kafka-trigger',    'Kafka Trigger',          'cdc-node-01-kafka-trigger.png');
    await snapNode(page, 'parse-message',    'Parse Message',          'cdc-node-02-parse-message.png');
    await snapNode(page, 'delete-vector',    'Delete Existing Vector', 'cdc-node-03-delete-vector.png');
    await snapNode(page, 'is-delete',        'Is Delete Event?',       'cdc-node-04-is-delete.png');
    await snapNode(page, 'generate-embedding', 'Generate Embedding',   'cdc-node-05-generate-embedding.png');
    await snapNode(page, 'build-point',      'Build Qdrant Point',     'cdc-node-06-build-point.png');
    await snapNode(page, 'insert-vector',    'Insert Vector',          'cdc-node-07-insert-vector.png');

    console.log('[CDC] Executions...');
    await page.goto(`${N8N}/workflow/${CDC_ID}/executions`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '06-cdc-executions-list.png');
    const firstExec = page.locator('[data-test-id="execution-list-item"]').first();
    if (await firstExec.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await firstExec.click();
      await page.waitForTimeout(2_000);
      await snap(page, '07-cdc-execution-detail.png');
    } else {
      // Trigger an event and wait
      try { execFileSync('kubectl', ['--context','kind-k8s-ai-classic','create','namespace','ss-ns'], { stdio:'pipe' }); } catch { /* exists */ }
      await new Promise(r => setTimeout(r, 8_000));
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(2_000);
      await snap(page, '06-cdc-executions-list.png');
      await page.locator('[data-test-id="execution-list-item"]').first().click().catch(() => {});
      await page.waitForTimeout(2_000);
      await snap(page, '07-cdc-execution-detail.png');
      execFileSync('kubectl', ['--context','kind-k8s-ai-classic','delete','namespace','ss-ns','--ignore-not-found','--wait=false'], { stdio:'pipe' });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // AI_K8s_Flow
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[AI] Opening workflow canvas...');
    await page.goto(`${N8N}/workflow/${AI_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '08-ai-workflow-canvas.png');

    console.log('[AI] Capturing node panels...');
    await snapNode(page, 'chat-trigger',       'Chat Trigger',       'ai-node-01-chat-trigger.png');
    await snapNode(page, 'generate-embedding', 'Generate Embedding', 'ai-node-02-generate-embedding.png');
    await snapNode(page, 'qdrant-search',      'Qdrant Search',      'ai-node-03-qdrant-search.png');
    await snapNode(page, 'build-prompt',       'Build Prompt',       'ai-node-04-build-prompt.png');
    await snapNode(page, 'llm-chat',           'LLM Chat',           'ai-node-05-llm-chat.png');
    await snapNode(page, 'format-response',    'Format Response',    'ai-node-06-format-response.png');

    console.log('[AI] Public chat interface...');
    await page.goto(`${N8N}/webhook/k8s-ai-chat/chat`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '09-ai-chat-public.png');
    const chatInput = page.locator('textarea, input[type="text"]').first();
    if (await chatInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await chatInput.fill('List all namespaces in the Kubernetes cluster');
      await snap(page, '10-ai-chat-query-typed.png');
      await chatInput.press('Enter');
      await page.waitForTimeout(20_000);
      await snap(page, '11-ai-chat-response.png');
    }

    console.log('[AI] Executions...');
    await page.goto(`${N8N}/workflow/${AI_ID}/executions`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '12-ai-executions-list.png');
    const firstAiExec = page.locator('[data-test-id="execution-list-item"]').first();
    if (await firstAiExec.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await firstAiExec.click();
      await page.waitForTimeout(2_000);
      await snap(page, '13-ai-execution-detail.png');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Reset_K8s_Flow
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Reset] Opening workflow canvas...');
    await page.goto(`${N8N}/workflow/${RESET_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '15-reset-workflow-canvas.png');

    console.log('[Reset] Capturing node panels...');
    await snapNode(page, 'reset-webhook',        'Reset Webhook',              'reset-node-01-webhook.png');
    await snapNode(page, 'delete-collection',    'Delete Qdrant Collection',   'reset-node-02-delete-collection.png');
    await snapNode(page, 'recreate-collection',  'Recreate Qdrant Collection', 'reset-node-03-recreate-collection.png');
    await snapNode(page, 'trigger-resync',       'Trigger Resync',             'reset-node-04-trigger-resync.png');
    await snapNode(page, 'format-reset-response','Format Response',            'reset-node-05-format-response.png');

    console.log('[Reset] Executions...');
    await page.goto(`${N8N}/workflow/${RESET_ID}/executions`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '16-reset-workflow-executions.png');
    const firstResetExec = page.locator('[data-test-id="execution-list-item"]').first();
    if (await firstResetExec.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await firstResetExec.click();
      await page.waitForTimeout(2_000);
      await snap(page, '16b-reset-execution-detail.png');
    }

    // ── Settings ───────────────────────────────────────────────────────────────
    console.log('\n[Settings] API settings page');
    await page.goto(`${N8N}/settings/api`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);
    await snap(page, '17-settings-api.png');

  } finally {
    await browser.close();
    console.log('\n[teardown] Restoring basic-auth...');
    if (existsSync(OVERRIDE)) unlinkSync(OVERRIDE);
    compose('up', '-d', '--no-deps', 'n8n');
    await new Promise(r => setTimeout(r, 4_000));
    console.log('[teardown] Done.\n');
  }

  const files = require('fs').readdirSync(SCREENSHOTS)
    .filter((f: string) => f.endsWith('.png')).sort();
  console.log(`\n${files.length} screenshots in docs/screenshots/:`);
  files.forEach((f: string) => console.log(`  ${f}`));
});

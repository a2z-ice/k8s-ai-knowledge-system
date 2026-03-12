/**
 * scripts/capture-screenshots.ts
 *
 * Captures all n8n UI screenshots for docs and the Medium article.
 * Saves to docs/screenshots/.
 *
 * Works with the k8s in-cluster setup (NodePort 30000).
 * HTTP Basic Auth (admin/admin) handled via httpCredentials.
 *
 * Usage:
 *   N8N_EMAIL=assaduzzaman.ict@gmail.com N8N_PASS=admin@123Normal npm run screenshots
 *
 * DOM facts:
 *   - Canvas nodes: .vue-flow__node[data-id="<nodeId>"]
 *   - Node Details View (config panel): [data-test-id="ndv"]
 *   - Single click on a node opens the NDV panel in n8n 2.x
 */

import { test, chromium, Page, BrowserContext } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';

const ROOT        = path.resolve(__dirname, '..');
const SCREENSHOTS = path.join(ROOT, 'docs', 'screenshots');
const N8N         = 'http://localhost:30000';

// Read .env if present
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && !key.startsWith('#') && rest.length) {
      process.env[key.trim()] ??= rest.join('=').trim();
    }
  }
}

const EMAIL          = process.env.N8N_EMAIL ?? (() => { throw new Error('Set N8N_EMAIL in env or .env'); })();
const PASS           = process.env.N8N_PASS  ?? (() => { throw new Error('Set N8N_PASS in env or .env');  })();
const BASIC_USER     = process.env.N8N_BASIC_AUTH_USER ?? 'admin';
const BASIC_PASS     = process.env.N8N_BASIC_AUTH_PASS ?? 'admin';

// Static workflow IDs (embedded in the JSON files)
const CDC_ID    = 'k8sCDCflow00001';
const AI_ID     = 'k8sAIflow000001';
const RESET_ID  = 'k8sRSTflow00001';
const MEM_ID    = 'k8sMEMclear001';

// ── helpers ───────────────────────────────────────────────────────────────────

async function snap(page: Page, filename: string) {
  await page.screenshot({ path: path.join(SCREENSHOTS, filename), fullPage: false });
  console.log(`    ✓ ${filename}`);
}

async function waitForN8N(maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${N8N}/healthz`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64') }
      });
      if (res.ok || res.status === 401) return; // 401 = running but auth required
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 1_000));
  }
  throw new Error('n8n not ready within 30s');
}

/**
 * Click a canvas node by its workflow JSON id, wait for NDV panel, screenshot.
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

  const opened = await ndv.isVisible({ timeout: 1_500 }).catch(() => false);
  if (!opened) {
    console.log(`    ✗ panel did not open for "${label}" — snapping current state`);
  }

  await snap(page, filename);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// ── main ──────────────────────────────────────────────────────────────────────

test('Capture all n8n UI screenshots', async () => {
  mkdirSync(SCREENSHOTS, { recursive: true });

  console.log('\n[setup] Waiting for n8n at http://localhost:30000...');
  await waitForN8N();
  console.log('[setup] n8n ready.\n');

  const browser = await chromium.launch({ headless: true });
  // HTTP Basic Auth credentials — required because N8N_BASIC_AUTH_ACTIVE=true
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    httpCredentials: { username: BASIC_USER, password: BASIC_PASS },
  });
  const page = await context.newPage();

  try {
    // ── Sign-in ────────────────────────────────────────────────────────────────
    console.log('[01] Sign-in page');
    await page.goto(N8N, { waitUntil: 'networkidle' });
    await page.waitForSelector('input[type="email"]', { timeout: 15_000 });
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

    console.log('[Create] Opening node creator...');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1_500);

    const nodeCreator = page.locator('[data-test-id="node-creator"]');
    if (!await nodeCreator.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const addBtn = page.locator('[data-test-id="canvas-add-button"], button[aria-label*="add"], .add-node-button').first();
      if (await addBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await addBtn.click();
        await page.waitForTimeout(1_500);
      }
    }
    await snap(page, 'create-02-node-creator-open.png');

    const searches: Array<[string, string]> = [
      ['kafka trigger',        'create-03-search-kafka-trigger.png'],
      ['http request',         'create-04-search-http-request.png'],
      ['code',                 'create-05-search-code.png'],
      ['if',                   'create-06-search-if.png'],
      ['webhook',              'create-07-search-webhook.png'],
      ['chat trigger',         'create-08-search-chat-trigger.png'],
      ['postgres chat memory', 'create-09-search-postgres-memory.png'],
    ];

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
      await snap(page, 'create-03-search-kafka-trigger.png');
    }

    await page.goto(`${N8N}/home/workflows`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1_500);

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
    await snapNode(page, 'kafka-trigger',      'Kafka Trigger',          'cdc-node-01-kafka-trigger.png');
    await snapNode(page, 'parse-message',      'Parse Message',          'cdc-node-02-parse-message.png');
    await snapNode(page, 'delete-vector',      'Delete Existing Vector', 'cdc-node-03-delete-vector.png');
    await snapNode(page, 'is-delete',          'Is Delete Event?',       'cdc-node-04-is-delete.png');
    await snapNode(page, 'format-document',    'Format Document',        'cdc-node-05-format-document.png');
    await snapNode(page, 'insert-to-qdrant',   'Insert to Qdrant',       'cdc-node-06-insert-to-qdrant.png');
    await snapNode(page, 'embeddings-ollama-cdc', 'Embeddings Ollama',   'cdc-node-07-embeddings-ollama.png');

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
      try { execFileSync('kubectl', ['--context','kind-k8s-ai','create','namespace','ss-ns'], { stdio:'pipe' }); } catch { /* exists */ }
      await new Promise(r => setTimeout(r, 8_000));
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(2_000);
      await snap(page, '06-cdc-executions-list.png');
      await page.locator('[data-test-id="execution-list-item"]').first().click().catch(() => {});
      await page.waitForTimeout(2_000);
      await snap(page, '07-cdc-execution-detail.png');
      execFileSync('kubectl', ['--context','kind-k8s-ai','delete','namespace','ss-ns','--ignore-not-found','--wait=false'], { stdio:'pipe' });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // AI_K8s_Flow
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[AI] Opening workflow canvas...');
    await page.goto(`${N8N}/workflow/${AI_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '08-ai-workflow-canvas.png');

    console.log('[AI] Capturing node panels...');
    await snapNode(page, 'chat-trigger',       'Chat Trigger',          'ai-node-01-chat-trigger.png');
    await snapNode(page, 'ai-agent',           'AI Agent',              'ai-node-02-ai-agent.png');
    await snapNode(page, 'ollama-chat-model',  'Ollama Chat Model',     'ai-node-03-ollama-chat-model.png');
    await snapNode(page, 'qdrant-vector-store','Qdrant Vector Store',   'ai-node-04-qdrant-vector-store.png');
    await snapNode(page, 'embeddings-ollama',  'Embeddings Ollama',     'ai-node-05-embeddings-ollama.png');
    await snapNode(page, 'postgres-memory',    'Postgres Chat Memory',  'ai-node-06-postgres-memory.png');

    console.log('[AI] Public chat interface...');
    await page.goto(`${N8N}/webhook/k8s-ai-chat/chat`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '09-ai-chat-public.png');
    const chatInput = page.locator('textarea, input[type="text"]').first();
    if (await chatInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await chatInput.fill('List all namespaces in the Kubernetes cluster');
      await snap(page, '10-ai-chat-query-typed.png');
      await chatInput.press('Enter');
      await page.waitForTimeout(25_000);
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
    await snapNode(page, 'reset-webhook',         'Reset Webhook',              'reset-node-01-webhook.png');
    await snapNode(page, 'delete-collection',      'Delete Qdrant Collection',   'reset-node-02-delete-collection.png');
    await snapNode(page, 'recreate-collection',    'Recreate Qdrant Collection', 'reset-node-03-recreate-collection.png');
    await snapNode(page, 'trigger-resync',         'Trigger Resync',             'reset-node-04-trigger-resync.png');
    await snapNode(page, 'format-reset-response',  'Format Response',            'reset-node-05-format-response.png');

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

    // ══════════════════════════════════════════════════════════════════════════
    // Memory_Clear_Flow
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[Memory] Opening Memory_Clear_Flow canvas...');
    await page.goto(`${N8N}/workflow/${MEM_ID}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);
    await snap(page, '17-memory-clear-workflow-canvas.png');

    console.log('[Memory] Capturing node panels...');
    await snapNode(page, 'manual-trigger',   'Manual Trigger',   'mem-node-01-manual-trigger.png');
    await snapNode(page, 'schedule-trigger', 'Schedule Trigger', 'mem-node-02-schedule-trigger.png');
    await snapNode(page, 'clear-memory',     'Clear Memory',     'mem-node-03-clear-memory.png');

    // ── pgAdmin ───────────────────────────────────────────────────────────────
    console.log('\n[pgAdmin] Capturing pgAdmin UI...');
    const pgAdminPage = await context.newPage();
    try {
      await pgAdminPage.goto('http://localhost:30003', { waitUntil: 'networkidle', timeout: 20_000 });
      await pgAdminPage.waitForTimeout(3_000);
      await pgAdminPage.screenshot({ path: path.join(SCREENSHOTS, '18-pgadmin-login.png'), fullPage: false });
      console.log('    ✓ 18-pgadmin-login.png');
    } catch (e) {
      console.log('    ✗ pgAdmin not reachable — skipping');
    } finally {
      await pgAdminPage.close();
    }

    // ── Settings ───────────────────────────────────────────────────────────────
    console.log('\n[Settings] API settings page');
    await page.goto(`${N8N}/settings/api`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_000);
    await snap(page, '17-settings-api.png');

  } finally {
    await browser.close();
    console.log('\n[teardown] Done.\n');
  }

  const files = require('fs').readdirSync(SCREENSHOTS)
    .filter((f: string) => f.endsWith('.png')).sort();
  console.log(`\n${files.length} screenshots in docs/screenshots/:`);
  files.forEach((f: string) => console.log(`  ${f}`));
});

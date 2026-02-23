/**
 * activate_n8n.ts
 *
 * One-time Playwright automation to:
 *  1. Log in to n8n (owner account created in a previous run)
 *  2. For each target workflow, click its active toggle in the UI
 *
 * Run: npx playwright test --config=activate_n8n_playwright.config.ts
 */

import { test, expect, chromium, Page } from '@playwright/test';

const N8N        = 'http://localhost:5678';
const BASIC_USER = 'admin';
const BASIC_PASS = 'admin';

// Owner account created during first-time setup
const OWNER_EMAIL = 'admin@k8s.local';
const OWNER_PASS  = 'Admin1234!';

// Workflow IDs from SQLite (sLFyTfSNzFIiVC9t = CDC, ZC5iZGx6MJY6YVKa = AI)
const TARGETS: Record<string, string> = {
  CDC_K8s_Flow: 'sLFyTfSNzFIiVC9t',
  AI_K8s_Flow:  'ZC5iZGx6MJY6YVKa',
};

// ── helpers ───────────────────────────────────────────────────────────────────

let step = 0;
async function snap(page: Page, label: string) {
  const file = `/tmp/n8n-activate-${String(++step).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  📸  ${file}`);
}

// ── main test ─────────────────────────────────────────────────────────────────

test('Activate n8n CDC and AI workflows', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    httpCredentials: { username: BASIC_USER, password: BASIC_PASS },
  });
  const page = await context.newPage();

  // ── STEP 1: Load n8n and detect state ────────────────────────────────────
  console.log('\n1. Opening n8n…');
  await page.goto(N8N, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_000); // give Vue time to mount
  await snap(page, 'initial');
  console.log('   URL:', page.url());
  console.log('   Title:', await page.title());

  // Detect state by inspecting visible elements (URL alone is unreliable with Vue SPA)
  const hasSetup   = await page.locator('text=Set up owner, [data-test-id="setup-form"]').first().isVisible({ timeout: 2_000 }).catch(() => false);
  const hasLogin   = await page.locator('input[type="email"]').first().isVisible({ timeout: 2_000 }).catch(() => false);
  const hasWorkflows = await page.locator('text=Workflows, nav, [data-test-id="main-sidebar"]').first().isVisible({ timeout: 2_000 }).catch(() => false);

  console.log('   State: setup=', hasSetup, 'login=', hasLogin, 'dashboard=', hasWorkflows);

  // ── STEP 2: Handle setup wizard ────────────────────────────────────────────
  if (hasSetup) {
    console.log('2. Setup wizard — filling owner form…');
    await page.locator('input[name="firstName"], input[placeholder*="first" i]').first().fill('Admin').catch(() => {});
    await page.locator('input[name="lastName"], input[placeholder*="last" i]').first().fill('K8s').catch(() => {});
    await page.locator('input[type="email"]').first().fill(OWNER_EMAIL);
    await page.locator('input[type="password"]').first().fill(OWNER_PASS);
    await snap(page, 'setup-filled');
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(5_000);
    await snap(page, 'post-setup');
    console.log('   After setup URL:', page.url());
  }

  // ── STEP 3: Login if form is visible ──────────────────────────────────────
  const needsLogin = hasLogin && !hasSetup;
  if (needsLogin) {
    console.log('3. Login form — signing in…');
    await page.locator('input[type="email"]').first().fill(OWNER_EMAIL);
    await page.locator('input[type="password"]').first().fill(OWNER_PASS);
    await snap(page, 'login-filled');
    // Debug: log all buttons on the page
    const btns = await page.locator('button').all();
    for (const b of btns) {
      const txt = await b.innerText().catch(() => '');
      const typ = await b.getAttribute('type').catch(() => '');
      const cls = await b.getAttribute('class').catch(() => '');
      console.log(`   button: type="${typ}" text="${txt.trim()}" class="${cls?.substring(0, 50)}"`);
    }
    // Press Enter to submit (works regardless of button type/selector)
    await page.locator('input[type="password"]').press('Enter');
    await page.waitForTimeout(6_000);
    await snap(page, 'post-login');
    console.log('   After login URL:', page.url());

    // If still on login, something is wrong
    const stillLogin = await page.locator('input[type="email"]').first().isVisible({ timeout: 2_000 }).catch(() => false);
    if (stillLogin) {
      await snap(page, 'login-failed');
      throw new Error(`Login failed — still on login form. URL: ${page.url()}`);
    }
  } else if (!hasSetup) {
    console.log('3. Already authenticated — skipping login.');
  }

  // ── STEP 4: Navigate to workflow list ─────────────────────────────────────
  console.log('4. Loading workflow list…');
  await page.goto(`${N8N}/home/workflows`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForTimeout(3_000); // give Vue time to render list
  await snap(page, 'workflows-list');
  console.log('   URL:', page.url());

  // If login was needed again, we're not authenticated
  if (page.url().includes('/signin') || await page.locator('input[type="email"]').first().isVisible({ timeout: 1_000 }).catch(() => false)) {
    throw new Error('Not authenticated after login attempt. Cannot access workflow list.');
  }

  // Dismiss any modal/onboarding dialog that blocks interaction
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').first();
  if (await dialog.isVisible({ timeout: 2_000 }).catch(() => false)) {
    console.log('   Dismissing onboarding dialog…');
    // Try Escape key first
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    // If still visible, try clicking the X button or Skip
    if (await dialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await page.locator('[role="dialog"] button').filter({ hasText: /skip|dismiss|close|×/i }).first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }
    // Last resort: click outside the dialog
    if (await dialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await page.mouse.click(10, 10);
      await page.waitForTimeout(500);
    }
  }
  await snap(page, 'after-dialog-dismiss');

  // ── STEP 5: Open each workflow in the editor and toggle Active in the header ─
  console.log('5. Activating workflows via the editor header toggle…');

  const activated: string[] = [];
  const alreadyActive: string[] = [];

  for (const [name, id] of Object.entries(TARGETS)) {
    console.log(`\n   Processing: ${name} (id=${id})`);

    // Navigate directly to the workflow editor
    await page.goto(`${N8N}/workflow/${id}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(3_000); // let editor fully render
    await snap(page, `editor-${name.replace(/[^a-z0-9]/gi, '-')}`);
    console.log('   Editor URL:', page.url());

    // The editor header has an Active toggle: data-test-id="workflow-activate-toggle"
    // or an el-switch, or a toggle button labeled "Active" / "Inactive"
    // Try data-test-id first
    let toggle = page.locator('[data-test-id="workflow-activate-toggle"]').first();
    let found = await toggle.isVisible({ timeout: 3_000 }).catch(() => false);

    if (!found) {
      // Try n8n's WorkflowActivator component toggle — typically a styled button or switch
      toggle = page.locator('.el-switch, [class*="activator"], [class*="toggle"][class*="active"]').first();
      found = await toggle.isVisible({ timeout: 2_000 }).catch(() => false);
    }

    if (!found) {
      // Debug: log all interactive elements in the editor header
      const headerHTML = await page.locator('[class*="header"], header').first().innerHTML().catch(() => 'N/A');
      console.log('   Header HTML:', headerHTML.substring(0, 600).replace(/\n/g, ''));
      console.log('   Could not find toggle in editor — skipping');
      continue;
    }

    // Debug: log toggle element details
    const toggleClass = await toggle.getAttribute('class').catch(() => '');
    const toggleHTML = await toggle.evaluate((el: Element) => el.outerHTML.substring(0, 300)).catch(() => 'N/A');
    console.log('   Toggle class:', toggleClass);
    console.log('   Toggle HTML:', toggleHTML.replace(/\n/g, ''));

    // Check current state
    const isActive = await toggle.evaluate((el: Element) =>
      el.classList.contains('is-checked') ||
      el.getAttribute('aria-checked') === 'true' ||
      (el.querySelector('input') as HTMLInputElement | null)?.checked === true
    ).catch(() => false);
    console.log(`   Current active state: ${isActive}`);

    if (isActive) {
      console.log(`   ✓ ${name} already active`);
      alreadyActive.push(name);
      continue;
    }

    // Click toggle to activate
    await toggle.click({ force: true });
    await page.waitForTimeout(3_000);

    // Check for notifications (n8n shows toast messages for errors/success)
    const notification = page.locator('[class*="notification"], [class*="toast"], [class*="alert"], .el-notification').first();
    if (await notification.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const msg = await notification.innerText().catch(() => '');
      console.log('   Notification:', msg.substring(0, 200));
    }

    // Check for error or confirmation dialog
    const dlg = page.locator('[role="dialog"]').first();
    if (await dlg.isVisible({ timeout: 1_500 }).catch(() => false)) {
      const dlgText = await dlg.innerText().catch(() => '');
      console.log('   Dialog appeared:', dlgText.substring(0, 200));
      // Click OK/Confirm/Activate
      await page.locator('[role="dialog"] button').filter({ hasText: /ok|confirm|activate|save/i }).first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(2_000);
    }

    await snap(page, `after-toggle-${name.replace(/[^a-z0-9]/gi, '-')}`);

    const nowActive = await toggle.evaluate((el: Element) =>
      el.classList.contains('is-checked') ||
      el.getAttribute('aria-checked') === 'true' ||
      (el.querySelector('input') as HTMLInputElement | null)?.checked === true
    ).catch(() => false);

    if (nowActive) {
      console.log(`   ✓ Activated ${name}`);
      activated.push(name);
    } else {
      // Log the page body text to understand what error/state is shown
      const bodySnippet = await page.locator('body').innerText().catch(() => '');
      console.log('   Body after toggle (last 300):', bodySnippet.slice(-300).replace(/\n/g, ' | '));
      console.log(`   ✗ Toggle clicked but ${name} still appears inactive`);
    }
  }

  await snap(page, 'final-state');
  await browser.close();

  console.log('\n✅  Done.');
  console.log('   Newly activated :', activated.join(', ') || '(none)');
  console.log('   Already active  :', alreadyActive.join(', ') || '(none)');

  const allActive = [...activated, ...alreadyActive];
  expect(allActive, 'CDC_K8s_Flow must be active').toContain('CDC_K8s_Flow');
  expect(allActive, 'AI_K8s_Flow must be active').toContain('AI_K8s_Flow');
});

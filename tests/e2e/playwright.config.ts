import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: ['**/playwright_k8s_ai_e2e.spec.ts'],
  timeout: 300_000,        // 5 min per test — AI Agent tool calls via qwen3:8b + think:false take ~2-4 min
  globalTimeout: 1_800_000, // 30 min total suite (10 tests incl. 3 AI Agent webhook calls via n8n)
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]],
  // API-only project — no browser installation required
  projects: [
    { name: 'api' }
  ],
  use: {
    // No browser. All tests use the `request` fixture for HTTP.
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  },
});

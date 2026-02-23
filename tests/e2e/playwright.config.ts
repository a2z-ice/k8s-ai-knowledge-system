import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: ['**/playwright_k8s_ai_e2e.spec.ts'],
  timeout: 120_000,      // 2 min per test — LLM + k8s ops can be slow
  globalTimeout: 600_000, // 10 min total suite
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

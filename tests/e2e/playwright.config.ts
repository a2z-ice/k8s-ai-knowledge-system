import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: ['**/playwright_k8s_ai_e2e.spec.ts'],
  timeout: 120_000,       // 2 min per test — LLM + k8s ops can be slow
  globalTimeout: 900_000, // 15 min total suite (accounts for qwen3:8b cold-load between AI tests)
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

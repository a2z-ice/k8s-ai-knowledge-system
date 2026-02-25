import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: ['**/playwright_k8s_ai_e2e.spec.ts'],
  timeout: 300_000,       // 5 min per test — qwen3:8b model switch can take 120 s on CPU hardware
  globalTimeout: 1_200_000, // 20 min total suite (extra headroom for model cold-load)
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

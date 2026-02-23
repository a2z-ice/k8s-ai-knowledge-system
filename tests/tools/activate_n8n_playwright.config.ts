import { defineConfig } from '@playwright/test';

export default defineConfig({
  testMatch: ['**/activate_n8n.ts'],
  timeout: 120_000,
  reporter: 'list',
  projects: [{ name: 'chromium' }],
  use: {
    // Limit individual action timeouts so they fail fast and don't eat the full 120s
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});

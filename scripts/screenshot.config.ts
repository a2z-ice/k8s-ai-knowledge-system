import { defineConfig } from '@playwright/test';
import * as path from 'path';

export default defineConfig({
  testMatch: ['**/capture-screenshots.ts'],
  timeout: 180_000, // 3 min — includes n8n restarts + LLM response time
  reporter: 'list',
  projects: [{ name: 'chromium' }],
  use: {
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  outputDir: path.join(__dirname, '../playwright-report/screenshots'),
});

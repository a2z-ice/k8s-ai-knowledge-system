import { defineConfig } from '@playwright/test';
import * as path from 'path';

export default defineConfig({
  testMatch: ['**/capture-screenshots.ts'],
  timeout: 480_000, // 8 min — includes n8n restarts, 18 node panels, LLM response
  reporter: 'list',
  projects: [{ name: 'chromium' }],
  use: {
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  outputDir: path.join(__dirname, '../playwright-report/screenshots'),
});

import { defineConfig, devices } from '@playwright/test';

/**
 * Stage-only playwright config for the layman flow (layman-qr-1600).
 * baseURL from PW_BASE_URL — NEVER runs against live :8080 unless pointed there.
 * Run: PW_BASE_URL=http://127.0.0.1:8145 node node_modules/.bin/playwright test \
 *        --config=playwright.layman.ts layman-stage.spec.ts
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PW_BASE_URL || 'http://127.0.0.1:8145',
    viewport: { width: 360, height: 780 }, // phone shape
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

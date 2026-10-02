import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // watchdog-zombie needs a server with OC_STALL_MS=20s (own config +
  // webServer) — against this (production-stall) server it would just time out
  testIgnore: /watchdog-zombie\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1, // sessions are shared server state — never parallel
  retries: 0,
  reporter: [['list']],
  use: {
    // default = the live referee (lk-pwa on 8080); a worktree lab overrides
    // with its own server (E2E_BASE_URL=http://127.0.0.1:8090) to prove its
    // own build, not the deployed one
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8080',
    viewport: { width: 360, height: 780 }, // phone shape
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream', // auto-grant mic
        '--use-fake-device-for-media-stream', // synthetic audio, no hardware
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

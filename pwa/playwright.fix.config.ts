// fix-session override (fix-main-151156, 10-30): same suite, aimed at this
// session's own production build on :3312 — never the live :8080, and on its
// own port so parallel sessions' lanes (:3311 …) never collide.
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
    baseURL: 'http://127.0.0.1:3312',
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

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // watchdog-zombie needs a server with OC_STALL_MS=20s (own config +
  // webServer) — against this (production-stall) server it would just time out
  // tree-first runs against the sandbox (:8090) — own config, own server
  testIgnore: /(watchdog-zombie|tree-first|first-turn-voice)\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1, // sessions are shared server state — never parallel
  retries: 0,
  reporter: [['list']],
  use: {
    // PW_BASE_URL aims the suite at a non-live server (the sandbox :8090) —
    // the default is the live :8080, so a worktree run gates live, not itself
    baseURL: process.env.PW_BASE_URL || 'http://127.0.0.1:8080',
    viewport: { width: 360, height: 780 }, // phone shape
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream', // auto-grant mic
        '--use-fake-device-for-media-stream', // synthetic audio, no hardware
        // PW_JITLESS=1: a shell with no JIT (MemoryDenyWriteExecute) — the
        // browser's V8 must run interpreter-only too
        ...(process.env.PW_JITLESS ? ['--js-flags=--jitless'] : []),
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

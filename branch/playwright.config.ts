import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // watchdog-zombie needs a server with OC_STALL_MS=20s (own config +
  // webServer) — against this (production-stall) server it would just time out
  // tree-first runs against the sandbox (:8090) — own config, own server
  // herdr-sim kills its brain — the sim stack only (playwright.sim.config.ts)
  // ux-calm-teach talks for real (STT on the Mac) — playwright.ux-calm.config.ts
  testIgnore: /(watchdog-zombie|tree-first|first-turn-voice|site-door|voice-wait|door-repro|stt-phone|herdr-sim|ux-calm-teach)\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1, // sessions are shared server state — never parallel
  retries: 0,
  reporter: [['list']],
  use: {
    // PW_BASE_URL aims the suite at a non-live server (the sandbox :8090) —
    // the default is the live :8080, so a worktree run gates live, not itself
    baseURL: process.env.PW_BASE_URL || 'http://127.0.0.1:8080',
    // a RETURNING device: the door walked + its first voice turn done — the
    // general suite tests the app behind the door (the sandbox serves the
    // door to every fresh device; e2e/tree-first.spec.ts owns the door itself
    // and runs fresh). Harmless on live: no door there, the keys are unread.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(process.env.PW_BASE_URL || 'http://127.0.0.1:8080').origin,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
          ],
        },
      ],
    },
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

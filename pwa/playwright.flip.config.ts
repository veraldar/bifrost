// flip-automation (ops/flip-automation): the M0/M3 scratch rig — same suite
// shape as the live config but aimed at a local production server on :3312,
// never the live :8080. The flip spec manages that server's lifecycle itself
// (restart mid-test = the flip window), so no webServer here.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /flip\.spec\.ts/,
  timeout: 320_000,
  expect: { timeout: 20_000 },
  workers: 1, // the spec restarts the shared scratch server — never parallel
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

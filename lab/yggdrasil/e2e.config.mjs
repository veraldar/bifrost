// Bifrost's playwright.config.ts, re-pointed: same settings, specs read in place
// from pwa/e2e, outputs kept inside the lab scratch dir. Used by run-e2e.sh.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAB = path.dirname(fileURLToPath(import.meta.url));
const PWA = path.resolve(LAB, '../../pwa');
const { defineConfig, devices } = createRequire(path.join(PWA, 'package.json'))('@playwright/test');

export default defineConfig({
  testDir: path.join(PWA, 'e2e'),
  outputDir: path.join(LAB, 'run/test-results'),
  testIgnore: /watchdog-zombie\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8080',
    viewport: { width: 360, height: 780 },
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

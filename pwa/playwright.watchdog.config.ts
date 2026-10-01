import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** watchdog-zombie.spec.ts needs a proxy with a 20s stall limit: the real
 *  server runs 10min, and faking a 10-min-quiet busy run in a test is not
 *  practical. Starts its own `next start` on 8098 with OC_STALL_MS set —
 *  the suite default (port 8080) never sees this spec (testIgnore there). */
const b = base as { use?: object };
export default defineConfig({
  ...b,
  testIgnore: [], // the base config ignores this spec — undo it here
  use: { ...b.use, baseURL: 'http://127.0.0.1:8098' },
  testMatch: /watchdog-zombie\.spec\.ts/,
  webServer: {
    command: 'npx next start -p 8098',
    url: 'http://127.0.0.1:8098',
    env: { OC_STALL_MS: '20000' },
    timeout: 90_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

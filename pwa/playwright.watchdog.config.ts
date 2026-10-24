import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** watchdog-zombie.spec.ts needs a proxy with a 20s stall limit: the real
 *  server runs 10min, and faking a 10-min-quiet busy run in a test is not
 *  practical. It runs on the SIM stack (scripts/sim-stack.sh), whose proxy
 *  has its own cwd — a second `next start` in pwa/ (this config's old
 *  webServer) shared the served sandbox's queue + live-run files:
 *    SIM_STALL_MS=20000 scripts/sim-stack.sh up
 *    npx playwright test -c playwright.watchdog.config.ts
 *  The suite default never sees this spec (testIgnore there). */
process.env.E2E_OC_URL ??= 'http://127.0.0.1:4111'; // the sim brain (e2e/brain.ts)
const baseURL = 'http://127.0.0.1:8096';
export default defineConfig({
  ...base,
  testIgnore: [], // the base config ignores this spec — undo it here
  use: {
    ...base.use,
    baseURL,
    // a returning device on THIS origin (the base config keys its door state to :8080)
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
          ],
        },
      ],
    },
  },
  testMatch: /watchdog-zombie\.spec\.ts/,
});

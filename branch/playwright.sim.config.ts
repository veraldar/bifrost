import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** The SIM stack (scripts/sim-stack.sh: :8096 → sim yggdrasil :4111 → the
 *  mock LLM): the triad states a real provider can't be driven into, and a
 *  brain that may be SIGKILLed. Run: scripts/sim-stack.sh up, then
 *  PW_BASE_URL=http://127.0.0.1:8096 npx playwright test -c playwright.sim.config.ts */
const baseURL = process.env.PW_BASE_URL || 'http://127.0.0.1:8096';
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /herdr-sim\.spec\.ts/,
  use: {
    ...base.use,
    baseURL,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(baseURL).origin,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
          ],
        },
      ],
    },
  },
});

import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** NIGHT-STAB-SERVE: the voice-stab gate asserts, aimed at the :8095 vstab
 *  stage (sim-vstab-pwa + the sandbox-tree worker as sim-stab2-agent).
 *  Stage facts go through e2e/lk-probe.py; PW_JITLESS because this runner
 *  shell is inside the hardened unit. Storage state must key the STAGE
 *  origin (:8095) or the home shows the door instead of the roots view. */
const baseURL = process.env.VSTAB_SIM_PWA || 'http://127.0.0.1:8095';
export default defineConfig({
  ...base,
  testIgnore: [],
  use: {
    ...base.use,
    baseURL,
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
  testMatch: /voice-stab2\.spec\.ts/,
});

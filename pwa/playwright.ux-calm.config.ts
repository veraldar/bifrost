import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** UX-CALM (10-27): the listen busy law, the footer with zero help text, and
 *  the first-turn walk-through (type · hold · hands-free + "over") — against
 *  the SANDBOX server (:8090 → yggdrasil, LiveKit, lk-agent-ygg), a returning
 *  phone. The walk's voice turns land in the test room (voice-test), never in
 *  MAIN. The sim (:8096) runs everything but the real voice walk. */
const baseURL = process.env.PW_BASE_URL || 'http://127.0.0.1:8090';
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /ux-calm(-teach)?\.spec\.ts/,
  timeout: 240_000,
  outputDir: 'test-results/ux-calm',
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

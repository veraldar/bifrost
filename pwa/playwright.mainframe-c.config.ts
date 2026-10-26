import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** MAINFRAME-C (10-26): the front page's roots — tap opens MAIN, hold talks to
 *  MAIN from the list. Against the SANDBOX server (:8090 → yggdrasil, LiveKit,
 *  lk-agent-ygg), a RETURNING phone (door walked, first voice turn done).
 *  The voice specs talk through Chrome's own capture path: the fake device
 *  plays a spoken wav as the mic. Voice turns go to the voice-test room
 *  (settings' voice tests switch) — MAIN's transcript is never written. */
const baseURL = process.env.PW_BASE_URL || 'http://127.0.0.1:8090';
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /mainframe-c-.*\.spec\.ts/,
  timeout: 180_000,
  outputDir: 'test-results/mainframe-c',
  use: {
    ...base.use,
    baseURL,
    // a phone that already said yes to the mic (its first voice turn is done)
    permissions: ['microphone'],
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(baseURL).origin,
          localStorage: [
            { name: 'bifrost-door', value: 'v2' },
            { name: 'bifrost-first-turn', value: '1' },
            { name: 'oz-mode', value: 'text' },
          ],
        },
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 412, height: 915 } },
    },
  ],
});

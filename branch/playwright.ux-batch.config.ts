import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** UX-BATCH (10-23): the typed turn, the door's "or type", the voice-test
 *  room — all on the SANDBOX server (:8090 → yggdrasil), phone-shaped.
 *  Every spec makes its own throwaway session or room: MAIN is never touched. */
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /ux-batch-.*\.spec\.ts/,
  timeout: 240_000,
  use: { ...base.use, storageState: undefined, baseURL: process.env.PW_BASE_URL || 'http://127.0.0.1:8090' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 } },
    },
  ],
});

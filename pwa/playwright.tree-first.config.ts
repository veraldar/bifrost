import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** The door + the first voice turn live on the SANDBOX server (:8090) only —
 *  the main config targets the live :8080, which doesn't carry the flow.
 *  Phone shape for real: the main config's Desktop Chrome project overrides
 *  its viewport. first-turn-voice talks to the real sandbox stack (LiveKit →
 *  lk-agent-ygg → STT → yggdrasil) through Chrome's own capture path. */
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /(tree-first|first-turn-voice)\.spec\.ts/,
  use: { ...base.use, baseURL: process.env.PW_BASE_URL || 'http://127.0.0.1:8090' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 } },
    },
  ],
});

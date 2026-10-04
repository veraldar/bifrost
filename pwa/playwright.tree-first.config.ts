import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Tree-first lives on the SANDBOX server (:8090) only — the main config
 *  targets the live :8080, which doesn't carry the flow. Phone shape for
 *  real: the main config's Desktop Chrome project overrides its viewport. */
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /tree-first\.spec\.ts/,
  use: { ...base.use, baseURL: 'http://127.0.0.1:8090' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 } },
    },
  ],
});

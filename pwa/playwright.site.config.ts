import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** veraldar.org's door (the site repo, static) — served from the working copy
 *  on loopback (SITE_DIR, default ~/Work/veraldar-site), or aimed at the
 *  deployed site with SITE_URL=https://veraldar.org (read-only checks). */
const SITE_DIR = process.env.SITE_DIR || join(homedir(), 'Work/veraldar-site');
const SITE_URL = process.env.SITE_URL || 'http://127.0.0.1:8777';

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /site-door\.spec\.ts/,
  use: {
    ...base.use,
    storageState: undefined,
    baseURL: SITE_URL,
    serviceWorkers: 'block', // the site's cache would answer instead of the working copy
  },
  webServer: process.env.SITE_URL
    ? undefined
    : {
        command: `python3 -m http.server 8777 --bind 127.0.0.1 --directory ${SITE_DIR}`,
        url: SITE_URL,
        reuseExistingServer: true,
        stdout: 'ignore',
        stderr: 'ignore',
      },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 }, hasTouch: true },
    },
  ],
});

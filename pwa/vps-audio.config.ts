import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 420_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'https://pwa.179-237-67-146.nip.io',
    viewport: { width: 360, height: 780 },
    launchOptions: {
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--in-process-gpu',
        '--js-flags=--jitless',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--allow-loopback-in-peer-connection',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

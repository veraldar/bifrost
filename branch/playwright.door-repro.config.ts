import { defineConfig, devices } from '@playwright/test';

/** THE PHONE-CLASS REPRO runner — a Pixel-class phone on 4× CPU throttle,
 *  cold contexts, against the sandbox serve on :8090 (what :8443 hands the
 *  phone). Real budgets, real user steps; RED before the fix, GREEN after. */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'door-repro.spec.ts',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/door-repro',
  use: {
    baseURL: 'http://127.0.0.1:8090',
    viewport: { width: 360, height: 780 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36',
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    locale: 'en-US',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${__dirname}/public/user-agi.wav`,
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
      ],
    },
  },
  projects: [{ name: 'pixel', use: { ...devices['Pixel 7'] } }],
});

import { defineConfig, devices } from '@playwright/test';

/** STT phone-class repro — the sandbox voice loop through the USER'S DOOR
 *  (:8443), mobile UA, cold start. The browser's fake audio device plays a
 *  real speech wav (fixtures/voice.wav padded for VAD) as the microphone —
 *  the same path a person's voice takes, no labmic build flag involved. */

const WAV =
  process.env.STT_MIC_WAV || '/tmp/opencode/wav-b.wav';

export default defineConfig({
  testDir: './e2e',
  testMatch: /stt-phone\.spec\.ts/,
  timeout: 300_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.STT_BASE_URL || 'http://127.0.0.1:8080',
    ignoreHTTPSErrors: true,
    ...devices['Pixel 7'],
    locale: 'en-US',
    permissions: ['microphone'], // = the user accepted the prompt
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${WAV}`,
      ],
    },
  },
});

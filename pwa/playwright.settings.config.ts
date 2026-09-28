import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  use: { ...(base as { use?: object }).use, baseURL: 'http://127.0.0.1:8099' },
  testMatch: /settings\.spec\.ts/,
});

import { defineConfig } from '@playwright/test';
import sim from './playwright.sim.config';

/** human-sim on the SIM stage (scripts/human-sim-gate.sh brings it up). Sequential, one worker. */
export default defineConfig({
  ...sim,
  testMatch: /human-sim\/.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  reporter: [['line']],
});

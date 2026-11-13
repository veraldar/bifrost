import { defineConfig } from '@playwright/test';
import sim from './playwright.sim.config';

/** hf-ptt-seam-* on the SIM stage with a scratch agent. Run:
 *  SIM_FRESH=1 SEAM_AGENT_UNIT=seam-agent-r2 scripts/sim-stack.sh up, then
 *  SEAM_AGENT_UNIT=seam-agent-r2 PW_BASE_URL=http://127.0.0.1:8096 npx playwright test -c playwright.seam.config.ts */
export default defineConfig({ ...sim, testMatch: /hf-ptt-seam-.*\.spec\.ts/ });

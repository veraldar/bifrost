import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { expect, test, type Page } from '@playwright/test';

/** voice-stab · the avalanche spec (SIM-GATE tier 2, real components):
 *  the 10-30 storm put ~46-66 job processes per minute on room 'main'
 *  (465 offers in 10 min live). This spec, against the vstab sim stage
 *  (sim-vstab-pwa :8095 + the sim worker with THE FIX), proves:
 *  1. happy path — one hold connects, the room gets exactly one agent
 *  2. busy path — at the load gate the mint refuses (429 voice_busy) and
 *     the roots render the busy note WITHOUT mint churn
 *  3. the pressure cannon — 40 rapid mints on one room (the storm's mint
 *     rate) leave ≤2 agents, ≤2 dispatch rows, and the room still agented
 *
 *  Stage facts (rooms, dispatches) go through e2e/lk-probe.py: this runner
 *  shell is jitless (MemoryDenyWriteExecute is user-wide), where the
 *  livekit-server-sdk's fetch/undici stack dies — python has no such limit.
 *  The browser assertions stay in the page; the worker poll uses node:http
 *  (no wasm). Learned the hard way in the first gate runs. */

const WAV = join(__dirname, 'fixtures/first-turn-en.wav');
const SIM_PWA = process.env.VSTAB_SIM_PWA || 'http://127.0.0.1:8095';
const WORKER_HTTP = process.env.VSTAB_WORKER_HTTP || 'http://127.0.0.1:18085';

/** any server-side fact: run the python probe (spawnSync, no wasm) */
const probe = (...args: string[]): string => {
  const r = spawnSync('python3', [join(__dirname, 'lk-probe.py'), ...args], {
    timeout: 60_000,
    encoding: 'utf8',
  });
  return (r.stdout || '').trim();
};
const agentCount = (room: string): number => {
  const out = probe('agent-count', room);
  const n = Number(out);
  return Number.isFinite(n) ? n : -1;
};
const dispatchRows = (room: string): number => {
  const out = probe('dispatch-rows', room);
  const n = Number(out);
  return Number.isFinite(n) ? n : -1;
};
const deleteRoom = (room: string): void => {
  probe('delete-room', room);
};

/** the sim worker's live job count (node:http — no wasm in this shell) */
const agentJobs = async (): Promise<number> =>
  new Promise((resolve) => {
    httpGet(`${WORKER_HTTP}/worker`, (res) => {
      if (res.statusCode !== 200) return resolve(-1);
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(Number(JSON.parse(body).active_jobs ?? 0));
        } catch {
          resolve(-1);
        }
      });
    }).on('error', () => resolve(-1));
  });

const mint = async (request: APIRequestContext, room: string): Promise<number> =>
  (await request.post(`${SIM_PWA}/api/token`, { data: { room } })).status();

/** drain the stage: delete this suite's rooms (their jobs end through the
 *  agent's own paths) and wait until the worker holds nothing — the busy
 *  gate is REAL, so any leftover job would rightly refuse the next test's
 *  mints (learned the hard way in the first gate run) */
async function drainStage() {
  // the worker MUST answer (a dead worker passed this vacuously in gate run
  // two) — then the rooms go and the real drain is waited out
  await expect.poll(agentJobs, { timeout: 20_000, intervals: [500] }).toBeGreaterThanOrEqual(0);
  for (const room of ['voice-test', 'vstab-sat', 'vstab-storm']) deleteRoom(room);
  await expect.poll(agentJobs, { timeout: 120_000, intervals: [1_000, 2_000, 5_000] }).toBeLessThanOrEqual(0);
}

/** hold the front-page roots in voice-test mode; asserts the room has its
 *  one agent DURING the hold, then releases into hands-free (room stays) */
async function holdRoots(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('mfc-init', '1');
    localStorage.setItem('bifrost-first-turn', '1');
    localStorage.setItem('oz-mode', 'text');
    localStorage.setItem('bifrost-voice-test', '1');
  });
  await page.goto('/');
  const roots = page.getByTestId('roots');
  await expect(roots).toBeVisible();
  const b = (await page.getByTestId('roots-hit').boundingBox())!;
  const c = { x: b.x + b.width * 0.4, y: b.y + b.height * 0.55 };
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await expect(roots).toContainText(/talk|opening/, { timeout: 15_000 });
  await expect.poll(() => agentCount('voice-test'), { timeout: 25_000, intervals: [500] }).toBe(1);
  await page.mouse.up();
}

import { type APIRequestContext } from '@playwright/test';

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(process.env.PW_JITLESS ? ['--js-flags=--jitless'] : []),
    ],
  },
});

test.beforeEach(async () => {
  // NIGHT-STAB-SERVE guard: this spec drives real rooms on the shared LiveKit
  // server — it must NEVER run against the live PWA/worker. Refuse loudly.
  const base = process.env.VSTAB_SIM_PWA || 'http://127.0.0.1:8095';
  if (!/:8095|:8096|:8196|:8145/.test(base)) {
    throw new Error(`voice-stab2 guard: refusing to run against ${base} (stage only)`);
  }
  await drainStage();
});

test('happy path: one hold, exactly one agent in the room, worker sane', async ({ page }) => {
  test.setTimeout(180_000);
  await holdRoots(page);
  await expect.poll(agentJobs, { timeout: 15_000, intervals: [500] }).toBeLessThanOrEqual(2);
  await page.context().close();
});

test('busy path: at the load gate the mint refuses 429 and the roots say so — no churn', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  // saturate: one synthetic job (mint for a room no page joins) + one held page
  expect(await mint(request, 'vstab-sat'), 'saturation mint served').toBe(200);
  await expect.poll(() => agentCount('vstab-sat'), { timeout: 30_000, intervals: [500] }).toBe(1);

  const pageA = await browser.newContext().then((c) => c.newPage());
  await holdRoots(pageA);
  await expect.poll(agentJobs, { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(2);

  // the third mint must be refused as voice_busy and RENDERED on the roots
  const ctxC = await browser.newContext();
  const pageC = await ctxC.newPage();
  let mintCount = 0;
  pageC.on('request', (r) => {
    if (r.url().endsWith('/api/token') && r.method() === 'POST') mintCount += 1;
  });
  await pageC.addInitScript(() => {
    sessionStorage.setItem('mfc-init', '1');
    localStorage.setItem('bifrost-first-turn', '1');
    localStorage.setItem('oz-mode', 'text');
  });
  await pageC.goto('/');
  const b = (await pageC.getByTestId('roots-hit').boundingBox())!;
  const c = { x: b.x + b.width * 0.4, y: b.y + b.height * 0.55 };
  await pageC.mouse.move(c.x, c.y);
  await pageC.mouse.down();
  await expect(pageC.getByTestId('roots')).toContainText(/voice busy/i, { timeout: 15_000 });
  // no churn: the refused page must not re-mint on a timer (the avalanche's
  // feedback shape) — a deliberate new hold is the only new attempt
  const at = mintCount;
  await pageC.waitForTimeout(6_000);
  expect(mintCount - at, 'no re-mint churn while busy').toBeLessThanOrEqual(1);
  await ctxC.close();

  await pageA.context().close();
  for (const room of ['vstab-sat', 'voice-test']) deleteRoom(room);
  await expect.poll(agentJobs, { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }).toBeLessThanOrEqual(1);
});

test('pressure cannon: 40 rapid mints on one room hold at ≤2 agents, ≤2 dispatch rows, still agented', async ({
  request,
}) => {
  test.setTimeout(240_000);
  const room = 'vstab-storm';
  deleteRoom(room);
  // the storm: 40 mints, burst-shaped — the storm's exact mint rate
  const codes: number[] = [];
  for (let i = 0; i < 40; i++) codes.push(await mint(request, room));
  // the reuse law: the first mint creates, the rest reuse the live room's
  // dispatch — a healthy worker refuses none of this (1 job = load 0.5 < 0.9)
  expect(codes.filter((s) => s === 200).length, 'mints served').toBe(40);

  // offers drain; the accept-time cap rejects every straggler
  await new Promise((r) => setTimeout(r, 8_000));
  await expect
    .poll(() => agentCount(room), { timeout: 30_000, intervals: [500] })
    .toBeLessThanOrEqual(2);
  expect(agentCount(room), 'the room is still agented').toBeGreaterThanOrEqual(1);
  expect(dispatchRows(room), 'dispatch rows bounded by the reuse law').toBeLessThanOrEqual(2);
  await expect.poll(agentJobs, { timeout: 90_000, intervals: [1_000] }).toBeLessThanOrEqual(1);
  deleteRoom(room);
});

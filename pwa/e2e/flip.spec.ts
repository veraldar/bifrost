import { execSync, spawn } from 'child_process';
import { openSync } from 'fs';
import { expect, test } from '@playwright/test';

/**
 * flip-automation contract (req 10-03): a flip restarts the proxy (and the
 * voice agent) under a live phone — the phone NEVER needs manual action.
 * Runs against the SCRATCH server on :3312 (never the live :8080); the spec
 * restarts that server mid-test to walk the flip window.
 *
 *  leg 1 — plain proxy restart under a hands-free client: the down-window
 *            is ANNOUNCED (flip-note), and the return re-arms quietly. The
 *            room + agent survive, so no re-mint may fire (the re-arm
 *            guard must not churn dispatches for an intact room).
 *  leg 2 — the flip window kills the agent dispatch, and the phone reloads
 *            mid-window (PWA reopen): restore lands agent-less, the re-arm
 *            machine mints again and again (bounded), goes LOUD past the
 *            window (flip-note + notification path), and still recovers
 *            hands-free the moment the window ends — zero taps anywhere.
 *
 * Today's-pain evidence this spec replaces: commit 46acf1e (M0).
 */

const NAME = `e2e-flip-${Date.now().toString(36)}`;
const PORT = 3312;
const BASE = `http://127.0.0.1:${PORT}`;
const PWA = process.cwd(); // pwa/
const LOG = '/tmp/opencode/flip-pwa.log';
const FREE = 'tap the bars to send';
const NOTE = '[data-testid="flip-note"]';

function srvUp(): Promise<boolean> {
  return fetch(`${BASE}/api/session`, { signal: AbortSignal.timeout(3_000) })
    .then((r) => r.ok)
    .catch(() => false);
}

async function waitSrv(want: boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if ((await srvUp()) === want) return;
    if (Date.now() - t0 > ms) throw new Error(`server did not ${want ? 'come up' : 'go down'} in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Start the scratch proxy with extra env (dead LIVEKIT_API_URL = broken
 *  agent dispatch — the flip-window stand-in for the restarted lk-agent). */
function srvStart(extra: Record<string, string> = {}): void {
  const logfd = openSync(LOG, 'a');
  spawn('npx', ['next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
    cwd: PWA,
    detached: true,
    stdio: ['ignore', logfd, logfd],
    env: { ...process.env, ...extra },
  }).unref();
}

function srvKill(): void {
  execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`, { stdio: 'ignore' });
}

async function readLog(): Promise<string> {
  return import('fs/promises').then((fs) => fs.readFile(LOG, 'utf8'));
}

test('flip window under a hands-free client — announced, bounded, self-healing', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const shot = (n: string) => page.screenshot({ path: `../artifacts/flip-${n}.png` });

  // --- session + hands-free entry with a real agent --------------------------
  const r = await page.request.post('/api/session', { data: { name: NAME } });
  expect(r.ok()).toBeTruthy();
  const { id: sessionId } = (await r.json()) as { id: string };
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  await page.getByRole('button', { name: 'push to talk' }).click(); // tap = hands-free
  const free = page.getByTestId('free-phase');
  await expect(free).toBeVisible({ timeout: 30_000 });
  await expect(free).toContainText(FREE, { timeout: 30_000 }); // listening, agent joined
  await shot('1-handsfree');

  try {
    // --- leg 1: plain proxy restart under the client -------------------------
    srvKill();
    await waitSrv(false, 15_000);
    // the down-window is ANNOUNCED (M0 pain 1 was silence)
    await expect(page.locator(NOTE)).toContainText('server down', { timeout: 10_000 });
    await shot('2-downwindow');
    srvStart(); // back up, same (good) env
    await waitSrv(true, 60_000);
    const mark = (await readLog()).length;
    await page.waitForTimeout(20_000); // zero-action observation
    // room + agent survived the proxy blip: re-armed quietly, no re-mint
    await expect(free).toContainText(FREE);
    await expect(page.locator(NOTE)).toHaveCount(0); // note cleared itself
    expect((await readLog()).slice(mark)).not.toContain('[token]');
    await shot('3-quiet-return');

    // --- leg 2: dispatch-dead window + a phone reload ------------------------
    // bound override: the loud path must fire inside the test, not after 8min
    await page.evaluate(() => localStorage.setItem('oz-flip-bound-ms', '15000'));
    srvKill();
    await waitSrv(false, 15_000);
    // LIVEKIT_API_URL → dead port: token mint succeeds, agent dispatch fails
    // (best-effort catch in token route) = the agent-less flip window
    srvStart({ LIVEKIT_API_URL: 'http://127.0.0.1:1' });
    await waitSrv(true, 60_000);
    await page.reload(); // the phone reopens the PWA mid-flip
    await expect(free).toBeVisible({ timeout: 30_000 });
    // restore lands agent-less: the machine starts working on its own
    await expect(page.locator(NOTE)).toContainText(/re-arming/, { timeout: 25_000 });
    const badLog = await readLog();
    expect(badLog).toContain('[token]'); // re-mint attempts are running
    expect(badLog).toContain('agent dispatch failed'); // and honestly failing
    await shot('4-agentless-rearming');
    // past the bound: LOUD (M0 pain 2 was a silent fake "listening")
    await expect(page.locator(NOTE)).toContainText(/flip window exceeded/i, {
      timeout: 45_000,
    });
    await shot('5-loud');

    // --- the window ends: dispatch alive again -------------------------------
    srvKill();
    await waitSrv(false, 15_000);
    srvStart(); // good env — the flip window is over
    await waitSrv(true, 60_000);
    const goodMark = (await readLog()).length;
    // hands-free re-arms ITSELF: fresh mint → dispatch → agent joins → hot mic
    await expect(free).toContainText(FREE, { timeout: 60_000 });
    await expect(page.locator(NOTE)).not.toContainText(/flip window exceeded/i, {
      timeout: 30_000,
    });
    await expect(page.getByText(/voice agent missing/i)).toHaveCount(0);
    expect((await readLog()).slice(goodMark)).toContain('[token]'); // a real re-mint happened
    await page.waitForTimeout(12_000); // and it STAYS healed (no flapping)
    await expect(free).toContainText(FREE);
    await expect(page.locator(NOTE)).toHaveCount(0);
    await shot('6-rearmed');
  } finally {
    // the scratch server must end UP and GOOD for any later tests/runs
    if (!(await srvUp())) {
      srvStart();
      await waitSrv(true, 60_000);
    }
    await page.request.delete(`/api/session/${sessionId}`).catch(() => {});
  }
});

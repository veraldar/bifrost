import { execSync, spawn } from 'child_process';
import { openSync } from 'fs';
import { expect, test } from '@playwright/test';

/**
 * M0 (flip-automation, req 10-03): reproduce the manual-re-entry pain.
 *
 * A flip restarts the proxy (and the voice agent) under a live phone. This
 * spec walks that sequence against the SCRATCH server on :3312 (never the
 * live :8080) and records what the client does with ZERO user action:
 *
 *  leg 1 — plain proxy restart under a hands-free client:
 *            down-window silence + zero-action survival (the quiet case)
 *  leg 2 — restart whose agent dispatch is dead, then a reload (what a phone
 *            does when the PWA reopens mid-flip): the client lands in an
 *            agent-less room that still claims "listening" — the fake — and
 *            after the proxy returns (dispatch alive again) NOTHING re-arms:
 *            no re-mint, no agent, no note. A manual tap is the only exit.
 *
 * The M0 assertions pin TODAY's behavior as evidence. The M1 commit flips
 * them to the auto-re-arm contract (bounded retry, re-enter listening on
 * return, loud timeout note).
 */

const NAME = `e2e-flip-m0-${Date.now().toString(36)}`;
const PORT = 3312;
const BASE = `http://127.0.0.1:${PORT}`;
const PWA = process.cwd(); // pwa/
const LOG = '/tmp/opencode/flip-pwa.log';
const FREE = 'tap the bars to send';

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

test('M0: flip-window restart under a hands-free client — what demands manual action today', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const shot = (n: string) =>
    page.screenshot({ path: `../artifacts/flip-m0-${n}.png`, fullPage: false });

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
    await page.waitForTimeout(8_000); // the down window
    // PAIN 1 (silence): nothing on screen says the server is gone
    await expect(page.locator('[data-testid="flip-note"]')).toHaveCount(0);
    await shot('2-downwindow');
    srvStart(); // back up, same (good) env
    await waitSrv(true, 60_000);
    await page.waitForTimeout(20_000); // zero-action observation
    // today the quiet case survives: strip still claims listening, no note
    await expect(free).toContainText(FREE);
    await expect(page.locator('[data-testid="flip-note"]')).toHaveCount(0);
    await shot('3-quiet-return');

    // --- leg 2: return with dispatch broken + a phone reload -----------------
    srvKill();
    await waitSrv(false, 15_000);
    // LIVEKIT_API_URL → dead port: token mint succeeds, agent dispatch fails
    // (best-effort catch in token route) = the agent-less flip window
    srvStart({ LIVEKIT_API_URL: 'http://127.0.0.1:1' });
    await waitSrv(true, 60_000);
    await page.reload(); // the phone reopens the PWA mid-flip
    await expect(free).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(12_000);
    // PAIN 2 (the fake): agent-less room, yet the UI claims a working
    // hands-free — no error, no note, nothing says nobody is transcribing
    await expect(free).toContainText(FREE);
    await expect(page.getByText(/voice agent missing/i)).toHaveCount(0);
    await expect(page.locator('[data-testid="flip-note"]')).toHaveCount(0);
    await shot('4-agentless-fake');
    // proof from the source: the dispatch genuinely failed server-side
    const badLog = await import('fs/promises').then((fs) => fs.readFile(LOG, 'utf8'));
    expect(badLog).toContain('agent dispatch failed');

    // --- the return: dispatch alive again, client left alone -----------------
    srvKill();
    await waitSrv(false, 15_000);
    srvStart(); // good env — the flip window is over
    await waitSrv(true, 60_000);
    const goodMark = (await import('fs/promises').then((fs) => fs.readFile(LOG, 'utf8'))).length;
    await page.waitForTimeout(25_000); // zero-action observation
    // PAIN 3 (no self-heal): no re-mint, no agent, no note — the strip keeps
    // faking listening and a manual tap is the only way back today
    await expect(free).toContainText(FREE);
    await expect(page.locator('[data-testid="flip-note"]')).toHaveCount(0);
    await shot('5-no-selfheal');
    const goodLog = (await import('fs/promises').then((fs) => fs.readFile(LOG, 'utf8'))).slice(
      goodMark
    );
    expect(goodLog).not.toContain('[token]'); // no re-dispatch was attempted
  } finally {
    // the scratch server must end UP and GOOD for any later tests/runs
    if (!(await srvUp())) {
      srvStart();
      await waitSrv(true, 60_000);
    }
    await page.request.delete(`/api/session/${sessionId}`).catch(() => {});
    void testInfo; // screenshots above carry the evidence
  }
});

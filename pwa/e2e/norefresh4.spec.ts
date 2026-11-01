/** NOREFRESH4: the watchdog must tell SILENT-DEAD from QUIET-ALIVE.
 *
 *  Q1-refuted-1 (second-opinion-voice.md): quiet hands-free — room up, agent
 *  in it, just no speech while the brain works a 30-90s run — tore down and
 *  rejoined every 15s FOREVER (the reconnect success path reset the
 *  once-guard). The fix: only a room with NO agent (after a grace window)
 *  self-heals, exactly ONCE per armed session (guard survives reconnects);
 *  quiet-but-alive rooms are healthy and stay.
 *
 *  Honesty rules (owner spec): every server-side fact via twirp WITH the
 *  service JWT (learned from norefresh2 — no JWT = silent {} = vacuous
 *  green); join history tracked by ACCUMULATING distinct joined_at stamps
 *  across kills (a single ListParticipants snapshot cannot see past a
 *  DeleteRoom); watchdog fires asserted against the app's own diag log
 *  (localStorage 'oz-diag'), not a console shim; the busy state is read
 *  from the rendered error, not assumed. Stage guard: refuses :8080 (live).
 */

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const NAME_BASE = `e2e-norefresh4-${Date.now().toString(36)}`;
let LK = { key: '', secret: '' };

/** minimal livekit service JWT (HS256, node:crypto — no sdk, jitless-safe) */
function svcJwt(room: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    iss: LK.key,
    sub: 'e2e-norefresh4',
    exp: now + 180,
    nbf: now - 5,
    video: { roomCreate: true, roomList: true, roomAdmin: true, room },
  });
  const sig = createHmac('sha256', LK.secret).update(`${head}.${payload}`).digest('base64url');
  return `${head}.${payload}.${sig}`;
}

/** twirp POST via curl — the hardened unit gives node neither fetch nor wasm */
function twirp(room: string, path: string, body: string): string {
  try {
    return execFileSync(
      'curl',
      [
        '-s', '-X', 'POST',
        '-H', `Authorization: Bearer ${svcJwt(room)}`,
        '-H', 'Content-Type: application/json',
        '--data', body,
        'http://127.0.0.1:7880/twirp/livekit.RoomService/' + path,
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
  } catch {
    return '{}';
  }
}

type Part = { identity?: string; joined_at?: number | string };

function participants(room: string): Part[] {
  try {
    const r = JSON.parse(twirp(room, 'ListParticipants', JSON.stringify({ room })));
    return r.participants ?? [];
  } catch {
    return []; // room gone = nobody in
  }
}

function agents(room: string): Part[] {
  return participants(room).filter((p) => (p.identity ?? '').startsWith('agent-'));
}

/** the phone participant's current join stamp — '' while out of the room */
function humanStamp(room: string): string {
  const me = participants(room).find((p) => p.identity === `user_${room}`);
  return me ? String(me.joined_at) : '';
}

/** ACCUMULATE every join stamp seen while this poller runs — across a
 *  DeleteRoom the list empties, so history only survives by collecting
 *  stamps as they appear. Auto-stops at `cap` distinct stamps (re-review:
 *  the 400ms curl poll must not leak past the scenario's needs).
 *  Returns stamps (read stamps.size / [...stamps]). */
function trackHumanStamps(room: string, cap = 4): Set<string> {
  const stamps = new Set<string>();
  const t = setInterval(() => {
    const s = humanStamp(room);
    if (s) {
      stamps.add(s);
      if (stamps.size >= cap) clearInterval(t);
    }
  }, 400);
  return stamps;
}

function deleteRoom(room: string): void {
  twirp(room, 'DeleteRoom', JSON.stringify({ room }));
}

/** diag events from the app's own pipeline (localStorage 'oz-diag') */
async function diagLines(page: Page, substr: string): Promise<string[]> {
  return page.evaluate((needle) => {
    try {
      const ev = JSON.parse(localStorage.getItem('oz-diag') || '[]') as { msg?: string }[];
      return ev.filter((e) => (e.msg ?? '').includes(needle)).map((e) => e.msg as string);
    } catch {
      return [];
    }
  }, substr);
}

/** fresh session id (transcript store) — deleted in afterEach */
const sessionIds: string[] = [];
async function newSession(slug: string): Promise<string> {
  const base = process.env.PW_BASE_URL || 'http://127.0.0.1:8090';
  const out = execFileSync(
    'curl',
    ['-s', '-X', 'POST', '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ name: slug }), `${base}/api/session`],
    { encoding: 'utf8' }
  );
  const id = String(JSON.parse(out).id ?? '');
  if (id) sessionIds.push(id);
  return id;
}

test.beforeAll(async () => {
  const env = readFileSync('.env.local', 'utf8');
  const get = (k: string) => {
    const m = env.match(new RegExp(`^${k}=(.*)$`, 'm'));
    if (!m) throw new Error(`${k} missing from .env.local`);
    return m[1]!.trim();
  };
  LK = { key: get('LIVEKIT_API_KEY'), secret: get('LIVEKIT_API_SECRET') };
});

test.afterAll(async () => {
  const base = process.env.PW_BASE_URL || 'http://127.0.0.1:8090';
  for (const id of sessionIds) {
    try {
      execFileSync('curl', ['-s', '-X', 'DELETE', `${base}/api/session/${id}`], { encoding: 'utf8' });
    } catch { /* best effort */ }
  }
});

/** open a session page as a returning device, wait for the preconnect join,
 *  arm hands-free, wait for the agent — the shared A-part of every scenario */
async function armHandsFree(page: Page, slug: string, sessionId: string): Promise<Set<string>> {
  await page.goto(`/session/${slug}?id=${sessionId}`);
  const stamps = trackHumanStamps(slug);
  await expect
    .poll(() => humanStamp(slug), { timeout: 25_000, message: 'phone never joined the room' })
    .not.toBe('');
  stamps.add(humanStamp(slug));
  // arm hands-free (tap toggles) — same entry norefresh2 uses
  await page.getByRole('button', { name: 'push to talk' }).click();
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 30_000 });
  // reload sentinel: gone if the page navigates
  await page.evaluate(() => ((window as { __norefresh4?: number }).__norefresh4 = 42));
  // the token mint dispatches an agent per connect — it must be IN the room
  await expect
    .poll(() => agents(slug).length, { timeout: 30_000, intervals: [500], message: 'agent never joined' })
    .toBeGreaterThanOrEqual(1);
  return stamps;
}

test.use({
  permissions: ['microphone'],
});

test('scenario 1: quiet-alive >30s with live agent — ZERO rejoins, watchdog never tears down', async ({ page }) => {
  test.setTimeout(150_000);
  const slug = `${NAME_BASE}-quiet`;
  const sessionId = await newSession(slug);
  const stamps = await armHandsFree(page, slug, sessionId);
  const agentStamp0 = String(agents(slug)[0]?.joined_at ?? '');
  expect(stamps.size, 'human joined exactly once before the hold').toBe(1);

  // hold hands-free QUIET for 35s (> 15s watchdog + 5s grace) while the
  // room and its agent just sit there — this was the 15s-churn trigger
  await page.waitForTimeout(35_000);

  // no rejoin: same stamp, exactly one
  expect(stamps.size, 'human rejoined during a quiet-alive hold').toBe(1);
  expect(humanStamp(slug), 'the original participant is still the one in the room').toBe([...stamps][0]);
  // the agent is untouched too (a teardown would re-dispatch a NEW agent)
  expect(agents(slug).length).toBe(1);
  expect(String(agents(slug)[0]?.joined_at ?? '')).toBe(agentStamp0);
  // the liveness branch RAN (positive proof, not absence-of-evidence)
  expect(await diagLines(page, 'room quiet 15s but agent present')).not.toHaveLength(0);
  expect(await diagLines(page, 'room silent 15s'), 'watchdog fired a teardown').toHaveLength(0);
  // calm hands-free state, no loss surfaced, same live page
  await expect(page.getByTestId('free-phase')).toBeVisible();
  await expect(page.getByText('voice connection lost')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __norefresh4?: number }).__norefresh4)).toBe(42);
});

test('scenario 2: forced dead room — exactly ONE rejoin, second death = busy, guard survives', async ({ page }) => {
  test.setTimeout(220_000);
  const slug = `${NAME_BASE}-dead`;
  const sessionId = await newSession(slug);
  const stamps = await armHandsFree(page, slug, sessionId);
  expect(stamps.size).toBe(1);

  // kill #1 — SILENT-DEAD: the client self-heals, exactly once
  deleteRoom(slug);
  await expect
    .poll(() => stamps.size, { timeout: 45_000, intervals: [500], message: 'no rejoin after kill 1' })
    .toBe(2);
  expect(humanStamp(slug), 'rejoined participant present').not.toBe('');
  // let the reconnect settle (watchdog re-arms on the new room, 15s window)
  await page.waitForTimeout(20_000);
  expect(stamps.size, 'more than ONE rejoin after kill 1').toBe(2);

  // kill #2 — the guard is spent: NO second auto-rejoin, busy surfaces
  deleteRoom(slug);
  await expect
    .poll(() => humanStamp(slug) === '', { timeout: 20_000, intervals: [400], message: 'participant never left after kill 2' })
    .toBe(true);
  await page.waitForTimeout(25_000); // > watchdog 15s + grace 5s + margin
  expect(stamps.size, 'a SECOND auto-rejoin happened — the guard did not survive').toBe(2);
  expect(humanStamp(slug)).toBe(''); // nobody home — honest, not a silent corpse
  await expect(page.getByText('voice connection lost')).toBeVisible();
  expect(await page.evaluate(() => (window as { __norefresh4?: number }).__norefresh4)).toBe(42);
});

test('scenario 3: six loaded concurrent joins — each room holds EXACTLY one agent over 60s', async ({ browser }) => {
  test.setTimeout(420_000);
  const N = 6;
  const slugs = Array.from({ length: N }, (_, i) => `${NAME_BASE}-load${i}`);
  const pages: Page[] = [];
  const stampSets: Set<string>[] = [];
  for (let i = 0; i < N; i++) {
    // OWN context per room: a shared context spills localStorage oz-mode='free'
    // into later pages (auto-armed hands-free → no push-to-talk button), and
    // raw contexts need the mic permission granted explicitly
    const c = await browser.newContext();
    await c.grantPermissions(['microphone']);
    const p = await c.newPage();
    await p.addInitScript(() => {
      localStorage.setItem('bifrost-door', 'v2');
      localStorage.setItem('bifrost-first-turn', '1');
      localStorage.setItem('oz-mode', 'text');
    });
    const sessionId = await newSession(slugs[i]);
    stampSets.push(await armHandsFree(p, slugs[i], sessionId));
    pages.push(p);
  }
  for (const s of slugs) {
    expect(agents(s).length, `${s}: not exactly 1 agent at t0`).toBe(1);
    expect(stampSets[slugs.indexOf(s)].size).toBe(1);
  }
  // 60s under load, sampled every 10s — exactly one agent per room, no rejoins
  for (let t = 10; t <= 60; t += 10) {
    await new Promise((r) => setTimeout(r, 10_000));
    for (let i = 0; i < N; i++) {
      expect(agents(slugs[i]).length, `${slugs[i]}: agent count at t=${t}s`).toBe(1);
      expect(stampSets[i].size, `${slugs[i]}: human rejoined by t=${t}s`).toBe(1);
    }
  }
  for (let i = 0; i < N; i++) {
    expect(await diagLines(pages[i], 'room silent 15s'), `${slugs[i]}: watchdog teardown`).toHaveLength(0);
  }
  for (const p of pages) await p.context().close();
});

test('scenario 4: ghost-guard exit race — 20 repeats, room stays warm, zero watchdog fires', async ({ page }) => {
  test.setTimeout(240_000);
  const slug = `${NAME_BASE}-race`;
  const sessionId = await newSession(slug);
  await page.goto(`/session/${slug}?id=${sessionId}`);
  const stamps = trackHumanStamps(slug);
  await expect.poll(() => humanStamp(slug), { timeout: 25_000 }).not.toBe('');
  stamps.add(humanStamp(slug));
  const stamp0 = humanStamp(slug);
  // reload sentinel: gone if the page navigates mid-race
  await page.evaluate(() => ((window as { __norefresh4?: number }).__norefresh4 = 42));

  for (let i = 0; i < 20; i++) {
    await page.getByRole('button', { name: 'push to talk' }).click();
    await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 30_000 });
    // the norefresh3-era race: the exit click lands 450ms after the tap —
    // just past the 400ms ghost guard, racing the watchdog's arm window
    await page.waitForTimeout(450);
    await page.getByTestId('free-exit').click();
    await expect(page.getByTestId('free-phase')).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(250);
    // every cycle: same participant, room never torn down or rejoined
    expect(humanStamp(slug), `cycle ${i}: room state changed`).toBe(stamp0);
  }
  expect(stamps.size, 'a rejoin happened during the 20 exit races').toBe(1);
  expect(await diagLines(page, 'room silent 15s'), 'watchdog fired in the exit race').toHaveLength(0);
  expect(await page.evaluate(() => (window as { __norefresh4?: number }).__norefresh4)).toBe(42);
});

test('scenario 5 (SILENT-DEAD): agent removed, room kept — watchdog heals EXACTLY once, second death = busy', async ({ page }) => {
  // re-review demand: every prior kill used DeleteRoom, which delivers
  // Disconnected (the SDK's own heal path). This scenario kills ONLY the
  // agent (RemoveParticipant, room stays) — no Disconnected reaches the
  // client, so the 15s silence watchdog itself must fire: liveness probe
  // finds no agent → grace → ONE teardown+rejoin (fresh agent), then a
  // second death with the budget spent surfaces the honest busy error.
  test.setTimeout(220_000);
  const slug = `${NAME_BASE}-silentdead`;
  const sessionId = await newSession(slug);
  const stamps = trackHumanStamps(slug, 3);
  await armHandsFree(page, slug, sessionId);
  expect(stamps.size).toBe(1);
  // isolate the watchdog: block /api/dispatch so the pre-existing 10s
  // honesty check CANNOT re-dispatch the agent (first full run: rearm
  // healed the room seamlessly and the watchdog rightly stayed put —
  // that heal tier is real, but it masks the teardown path under test)
  await page.route('**/api/dispatch', (route) => route.fulfill({ status: 500, body: 'blocked for S5' }));

  // SILENT-DEAD: remove the agent, KEEP the room — the client sees only
  // ParticipantDisconnected, then pure silence
  twirp(slug, 'RemoveParticipant', JSON.stringify({ room: slug, identity: agents(slug)[0]!.identity }));
  await expect
    .poll(() => agents(slug).length, { timeout: 15_000, intervals: [400], message: 'agent never left' })
    .toBe(0);
  // the watchdog's fire window: lastEvt re-armed on ParticipantDisconnected
  // → 15s + 5s grace + reconnect backoff. NO Disconnected arrives — only
  // the watchdog can heal this.
  await expect
    .poll(() => stamps.size, { timeout: 40_000, intervals: [500], message: 'watchdog never healed the silent-dead room' })
    .toBe(2);
  await expect
    .poll(() => agents(slug).length, { timeout: 30_000, intervals: [500], message: 'no fresh agent after the heal' })
    .toBeGreaterThanOrEqual(1);
  expect(await diagLines(page, 'room silent 15s while hands-free'), 'the watchdog, not the SDK, must log this heal').toHaveLength(1);
  expect(await diagLines(page, 'room dead and reconnect already spent')).toHaveLength(0);
  // the healed room settles with exactly one agent (fresh dispatch)
  await page.waitForTimeout(3_000);
  expect(agents(slug).length, 'duplicate agents after the heal').toBe(1);
  // no reload — the same page healed itself
  expect(await page.evaluate(() => (window as { __norefresh4?: number }).__norefresh4)).toBe(42);

  // second SILENT-DEATH, room KEPT, budget spent: the watchdog's own
  // spent-guard branch must answer (no Disconnected exists to do it):
  // diag 'room dead and reconnect already spent' ×1, NO third stamp,
  // and the honest error on screen (re-review round-2 GO-path item 2)
  twirp(slug, 'RemoveParticipant', JSON.stringify({ room: slug, identity: agents(slug)[0]!.identity }));
  await expect
    .poll(() => agents(slug).length, { timeout: 15_000, intervals: [400], message: 'agent never left (2nd death)' })
    .toBe(0);
  await expect
    .poll(() => diagLines(page, 'room dead and reconnect already spent').length, { timeout: 40_000, intervals: [500], message: 'the watchdog spent-guard branch never fired' })
    .toBe(1);
  await page.waitForTimeout(5_000);
  expect(stamps.size, 'a second silent-dead heal happened — budget was spent').toBe(2);
  expect(humanStamp(slug), 'the healed participant must still be in the kept room').not.toBe('');
  await expect(page.getByText('voice connection lost')).toBeVisible();
});

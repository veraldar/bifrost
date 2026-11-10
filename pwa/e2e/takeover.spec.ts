import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { RoomServiceClient } from 'livekit-server-sdk';

/** Regression (diag 2026-10-30 12:41 UTC, room 'main', "voice connect
 *  failed: signal timeout (12s)"): the same PWA session open on two clients
 *  (phone + a Mac Chrome) — both mint `user_<room>` — means every fresh
 *  phone join is duplicate-killed by the server ~100ms after signal
 *  connect. The old Disconnected handler self-healed: remint → redial →
 *  killed again → an endless connect/kill war (hundreds of dispatches, 50+
 *  agent jobs, LiveKit "no worker available") and the press that started it
 *  died on the 12s signal timeout. The fix:
 *  1. DUPLICATE_IDENTITY sets a takeover latch — NO self-heal, one honest
 *     error message; a deliberate mic press clears the latch and takes the
 *     seat back (which duplicate-kills the other client — it now shows the
 *     same message on its side).
 *  2. /api/token skips the dispatch when an agent is already in the room
 *     and throttles to one dispatch per room per 5s — no more job storms.
 * This spec stages the exact incident with a second real browser page on
 * the same session (that IS the Mac) and requires: no reconnect storm, the
 * takeover message on the killed side, and healing by a deliberate press. */
const NAME = `e2e-takeover-${Date.now().toString(36)}`;
let sessionId = '';
let svc: RoomServiceClient;
const HUMAN = `user_${NAME}`;

function lkCreds(): { key: string; secret: string } {
  const env = readFileSync('.env.local', 'utf8');
  const get = (k: string) => {
    const m = env.match(new RegExp(`^${k}=(.*)$`, 'm'));
    if (!m) throw new Error(`${k} missing from .env.local`);
    return m[1].trim();
  };
  return { key: get('LIVEKIT_API_KEY'), secret: get('LIVEKIT_API_SECRET') };
}

const humanCount = async () =>
  (await svc.listParticipants(NAME)).filter((p) => p.identity === HUMAN).length;
const agentCount = async () =>
  (await svc.listParticipants(NAME)).filter((p) => p.identity !== HUMAN).length;
const TAKEN = 'this session is open on another device — voice moved there';

test.beforeAll(async ({ request }) => {
  sessionId = (await (await request.post('/api/session', { data: { name: NAME } })).json()).id;
  const { key, secret } = lkCreds();
  svc = new RoomServiceClient('http://127.0.0.1:7880', key, secret);
});
test.afterAll(async ({ request }) => {
  if (sessionId) await request.delete(`/api/session/${sessionId}`);
});

test('duplicate identity kills stop self-heal, message shows, mic press takes over', async ({
  page,
}) => {
  // --- client A (the phone in the incident) ---
  await page.goto(`/session/${NAME}?id=${sessionId}`);
  await page.getByRole('button', { name: 'push to talk' }).click(); // hands-free on
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 30_000 });
  await expect.poll(agentCount, { timeout: 30_000, message: 'agent never joined' }).toBeGreaterThan(0);
  await expect.poll(humanCount, { timeout: 10_000, message: 'A never held the seat' }).toBe(1);

  // --- client B joins the SAME session (the Mac at 12:41): its preconnect
  // dials the same identity and the server duplicate-kills A ---
  const pageB = await page.context().newPage();
  await pageB.goto(`/session/${NAME}?id=${sessionId}`);

  // A sees the honest takeover words — and does NOT remint/redial (the war
  // is dead; pre-2026-10-30 code would have been reconnecting forever here)
  await expect(page.getByText(TAKEN)).toBeVisible({ timeout: 20_000 });
  const diag = await page.evaluate(
    () => (window as unknown as { ozDiagDump?: () => string }).ozDiagDump?.() ?? ''
  );
  const connects = (diag.match(/connecting signal…/g) ?? []).length;
  expect(connects, 'self-heal must not redial into a stolen seat').toBeLessThan(3);
  // B now holds the seat
  await expect.poll(humanCount, { timeout: 15_000, message: 'B never took the seat' }).toBe(1);

  // --- the deliberate press is the takeover: A dials fresh, B is killed in
  // turn and shows the SAME message on its side; the agent stays put ---
  await page.getByRole('button', { name: 'push to talk' }).click();
  await expect(page.getByText(TAKEN)).toHaveCount(0);
  await expect
    .poll(humanCount, { timeout: 20_000, message: 'A never took the seat back' })
    .toBe(1);
  await expect(pageB.getByText(TAKEN)).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(agentCount, { timeout: 20_000, message: 'agent vanished during takeover' })
    .toBeGreaterThan(0);
});

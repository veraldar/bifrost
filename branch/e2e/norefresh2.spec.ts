import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

/** mic-norefresh2: hands-free dies server-side (room deleted under the
 *  phone). Old behavior: the pill kept saying ready on a dead room forever
 *  (or a silent socket stall) until a manual reload. The fix: a 15s
 *  no-event watchdog plus the Disconnected path tear down ONCE and
 *  reconnect with a fresh token + dispatch — no page reload, and if that
 *  one attempt fails the page shows the busy error instead of looping.
 *  NOTE: node runs jitless in the hardened unit (no fetch, no WASM) — the
 *  sdk/undici import is out; LiveKit control RPCs go through curl + a
 *  hand-minted HS256 service JWT (node:crypto only). */
const NAME = `e2e-norefresh2-${Date.now().toString(36)}`;
let sessionId = '';
let LK = { key: '', secret: '' };
const HUMAN = `user_${NAME}`;

/** minimal livekit service JWT (HS256, node:crypto — no sdk) */
function svcJwt(): string {
  // admin APIs need video grants, admin scoped to the test room
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    iss: LK.key,
    sub: 'e2e-norefresh2',
    exp: now + 120,
    nbf: now - 5,
    video: { roomCreate: true, roomList: true, roomAdmin: true, room: NAME },
  });
  const sig = createHmac('sha256', LK.secret)
    .update(`${head}.${payload}`)
    .digest('base64url');
  return `${head}.${payload}.${sig}`;
}

/** twirp POST via curl — the hardened unit gives node neither fetch nor wasm */
function twirp(path: string, body: string): string {
  return execFileSync(
    'curl',
    [
      '-s',
      '-X',
      'POST',
      '-H',
      `Authorization: Bearer ${svcJwt()}`,
      '-H',
      'Content-Type: application/json',
      '--data',
      body,
      `http://127.0.0.1:7880/twirp/livekit.RoomService/${path}`,
    ],
    { encoding: 'utf8' }
  );
}

/** the phone participant's join stamp — '' while it is out of the room */
function humanJoined(): string {
  try {
    const r = JSON.parse(twirp('ListParticipants', JSON.stringify({ room: NAME })));
    const me = (r.participants ?? []).find((p: { identity: string }) => p.identity === HUMAN);
    return me ? String(me.joined_at) : '';
  } catch {
    return ''; // room gone = nobody in
  }
}

async function curlJson(method: string, path: string, body?: string): Promise<string> {
  const base = process.env.PW_BASE_URL || 'http://127.0.0.1:8090';
  const args = ['-s', '-X', method, `${base}${path}`];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', body);
  return execFileSync('curl', args, { encoding: 'utf8' });
}

test.beforeAll(async () => {
  const env = readFileSync('.env.local', 'utf8');
  const get = (k: string) => {
    const m = env.match(new RegExp(`^${k}=(.*)$`, 'm'));
    if (!m) throw new Error(`${k} missing from .env.local`);
    return m[1].trim();
  };
  LK = { key: get('LIVEKIT_API_KEY'), secret: get('LIVEKIT_API_SECRET') };
  const created = JSON.parse(await curlJson('POST', '/api/session', JSON.stringify({ name: NAME })));
  sessionId = created.id;
});
test.afterAll(async () => {
  if (sessionId) await curlJson('DELETE', `/api/session/${sessionId}`);
});

test('server-side room kill under armed hands-free reconnects without reload', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sessionId}`);

  // the preconnect has the phone in the room — that is the join to watch
  let firstJoin = '';
  await expect
    .poll(humanJoined, { timeout: 20_000, message: 'phone never joined the room' })
    .not.toBe('');
  firstJoin = humanJoined();

  // arm hands-free (tap toggles) — kill fast: sim rooms have no voice agent
  // (dispatch names sim-none), so the mic-open wait exits free after ~8s
  await page.getByRole('button', { name: 'push to talk' }).click();
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 30_000 });

  // the reload sentinel: if the page navigates, this is gone
  await page.evaluate(() => ((window as { __norefresh2?: number }).__norefresh2 = 42));

  // kill the room under the phone — the client is left holding a corpse
  twirp('DeleteRoom', JSON.stringify({ room: NAME }));

  // the fix heals itself: the phone REJOINS (a new join stamp) WITHOUT a
  // page reload. Either path qualifies: Disconnected → reconnectVoice, or
  // the 15s no-event watchdog → teardown + reconnect.
  await expect
    .poll(humanJoined, {
      timeout: 45_000,
      message: 'client never reconnected the room after the kill',
    })
    .not.toBe(firstJoin);

  // still the same live page (no refresh), still hands-free, no busy error
  expect(await page.evaluate(() => (window as { __norefresh2?: number }).__norefresh2)).toBe(42);
  await expect(page.getByTestId('free-phase')).toBeVisible();
  await expect(page.getByText('voice connection lost')).toHaveCount(0);
});

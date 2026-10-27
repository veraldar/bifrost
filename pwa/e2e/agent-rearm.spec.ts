import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { RoomServiceClient } from 'livekit-server-sdk';

/** Regression (diag 2026-10-06 14:35, room main-veraldar): a network flap
 *  makes the LiveKit SDK self-reconnect into a fresh server-side room whose
 *  dispatch died with the first agent job — the client stays voiceState
 *  'ready', so every agent wait ran out with 'voice agent missing from the
 *  room' while lk-agent was perfectly healthy. The fix re-arms the dispatch
 *  into the room the phone is ALREADY in (/api/dispatch) before blaming
 *  lk-agent. This spec stages the exact zombie state server-side: remove
 *  the agent participant from a connected room — the client never sees a
 *  Disconnected, the room just has nobody in it — then requires hands-free
 *  tap-to-send to heal (agent re-joins, no error) instead of erroring. */
const NAME = `e2e-rearm-${Date.now().toString(36)}`;
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

async function participants(): Promise<string[]> {
  return (await svc.listParticipants(NAME)).map((p) => p.identity);
}

async function agentIdentity(): Promise<string | null> {
  const ids = await participants();
  return ids.find((i) => i !== HUMAN) ?? null;
}

test.beforeAll(async ({ request }) => {
  sessionId = (await (await request.post('/api/session', { data: { name: NAME } })).json()).id;
  const { key, secret } = lkCreds();
  svc = new RoomServiceClient('http://127.0.0.1:7880', key, secret);
});
test.afterAll(async ({ request }) => {
  if (sessionId) await request.delete(`/api/session/${sessionId}`);
});

test('agent-less ready room heals via re-dispatch on tap-to-send', async ({ page }) => {
  await page.goto(`/session/${NAME}?id=${sessionId}`);

  // hands-free on (tap = toggle, req 09-30): the preconnect has the room
  // dialing; the agent should join within seconds of the dispatch
  await page.getByRole('button', { name: 'push to talk' }).click();
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 30_000 });

  // wait for the agent to be IN the room (server-side truth, not UI)
  await expect
    .poll(agentIdentity, { timeout: 30_000, message: 'agent never joined the room' })
    .toBeTruthy();

  // stage the zombie: kill the agent participant server-side. The client
  // keeps its 'ready' room — no Disconnected fires — exactly the post-flap
  // state from the incident (fresh room, no dispatch, nobody in it).
  const agent = (await agentIdentity())!;
  await svc.removeParticipant(NAME, agent);
  await expect
    .poll(async () => (await participants()).length, {
      timeout: 10_000,
      message: 'agent did not leave after removal',
    })
    .toBe(1);

  // tap-to-send must NOT error — it re-arms the dispatch and waits the
  // agent back (old behavior: 'voice agent missing' after 4s)
  await page.getByRole('button', { name: 'send what you said' }).click();
  await expect
    .poll(agentIdentity, { timeout: 25_000, message: 're-arm did not bring the agent back' })
    .toBeTruthy();
  await expect(page.getByText('voice agent missing from the room')).toHaveCount(0);
});

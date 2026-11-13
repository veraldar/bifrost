import { expect, test } from '@playwright/test';

/** VOICE-BUGS round 1 — R5a, voice-brevity wire proof (sim stack, one session).
 *
 *  PHASE B ONLY: the per-turn `modality` lands with the brain fork
 *  (voice-turn-brevity) and the agent's commit_turn forwarding. Nothing on the
 *  PWA side can observe it earlier, and the sim has no voice agent — so this
 *  spec posts the two turns the way the agent will (modality:'voice' on the
 *  voice turn, none on the text turn) and asserts what the brain STORED.
 *  Skipped unless R5A_PHASE_B=1. (The note's rendering at the provider and the
 *  byte-stable prefix are R5b's `cargo test` job; the mock-provider capture
 *  could not be read from this sandbox, so it is not asserted here.) */
test.skip(!process.env.R5A_PHASE_B, 'phase B: needs the brain fork + agent modality tag');

type Msg = { role: string; text: string; modality?: string };

test('R5a: voice turn stored modality=voice; text turn carries none; prefix stable', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const name = `e2e-r5a-${Date.now().toString(36)}`;
  expect((await page.request.post('/api/session', { data: { name } })).ok()).toBe(true);
  const list = async (): Promise<Msg[]> => {
    const r = await page.request.get(`/api/session/${name}/messages?limit=50`);
    const j = (await r.json()) as Msg[] | { messages: Msg[] };
    return Array.isArray(j) ? j : j.messages;
  };
  const settled = async (assistants: number) =>
    expect
      .poll(async () => (await list()).filter((m) => m.role === 'assistant').length, {
        timeout: 90_000,
      })
      .toBeGreaterThanOrEqual(assistants);

  await page.request.post(`/api/session/${name}/messages`, {
    data: { text: 'voice turn one', modality: 'voice', async: true },
  });
  await settled(1);
  const afterOne = await list();
  await page.request.post(`/api/session/${name}/messages`, {
    data: { text: 'text turn two', async: true },
  });
  await settled(2);
  const afterTwo = await list();

  const u = (ms: Msg[], t: string) => ms.find((m) => m.role === 'user' && m.text.includes(t));
  expect(u(afterTwo, 'voice turn one')?.modality, 'voice turn stores modality=voice').toBe('voice');
  expect(u(afterTwo, 'text turn two')?.modality, 'text turn carries no modality').toBeFalsy();
  // history is append-only: turn 1's stored prefix is unchanged by turn 2
  expect(JSON.stringify(afterTwo.slice(0, afterOne.length))).toBe(JSON.stringify(afterOne));
});

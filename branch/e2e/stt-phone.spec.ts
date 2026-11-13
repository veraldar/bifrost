import { expect, test } from '@playwright/test';

/** STT phone-class repro for the sandbox voice loop (URD v0.7 FAIL —
 *  "spoke, no voice-to-text"), v2 door edition: cold start on the user's
 *  door (:8443), mobile UA, HOLD the tree → lang → style → continue →
 *  MAIN's first-turn card → HOLD the mic and TALK. The talk is a real
 *  speech wav fed at the browser audio-device layer (config launch args),
 *  so whatever reaches the agent's STT went through the full client path:
 *  getUserMedia → transceiver → LiveKit → agent → STT backend.
 *
 *  PASS = (A) a fresh user transcript lands in MAIN (backend STT alive) AND
 *         (B) it is OUR wav's sentence (the mic is the device — a baked-in
 *             lab wav shows the sentinel phrases instead). */

// the fake-audio resample mangles the head ("Eifelst"≈"Bifrost"); the
// distinctive tail + the sentinel guard (C) carry the identity
const EXPECT = /bridge\s+voice\s+test/i;
const LABMIC_SENTINEL = /capital of france|sleep better|kind about my day/i;
// hidden store messages (onboarding instructions, standing-preferences
// preamble) ride as role=user but are never the person's voice
const HIDDEN = /^\[(bifrost onboarding|bifrost · standing preferences)/;

/** one PTT turn: hold past the 250ms arm, keep it through a wav cycle */
async function holdTalk(page: import('@playwright/test').Page, ms: number) {
  const mic = page.getByRole('button', { name: 'push to talk' });
  await expect(mic).toBeVisible({ timeout: 30_000 });
  const b = (await mic.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test('stt: cold start → door → MAIN → hold mic → talk → transcript', async ({ page, request }) => {
  test.setTimeout(300_000);

  // cold start: fresh context, the exact user entry door
  // STT_LABMIC=1 opts the page into the lab-mic injection (?labmic=1) — the
  // RED leg demonstrating the 10-14 client hijack (device mic replaced by
  // the baked-in wav loop). Never set for the user-path runs.
  await page.goto(process.env.STT_LABMIC ? '/session/main?labmic=1' : '/');
  if (process.env.STT_LABMIC) {
    // isolated client-hijack leg: straight into MAIN, hold + talk
    const start = Date.now() - 2_000;
    await holdTalk(page, 4_000);
    await page.waitForTimeout(8_000);
    await holdTalk(page, 4_000);
    const txt = await pollFresh(page, request, start, 90_000);
    expect.soft(txt, 'RED-B: hijacked mic transcribes the BAKED wav, not ours').toMatch(LABMIC_SENTINEL);
    expect.soft(txt, 'RED-B: our fake-mic sentence never arrives').not.toMatch(EXPECT);
    return;
  }

  const tree = page.getByTestId('tree-first');
  await expect(tree).toBeVisible({ timeout: 30_000 });
  await tree.click(); // press+release — the v2 door opens in place
  await expect(page.getByTestId('door-lang-en')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('door-lang-en').click();
  await expect(page.getByTestId('door-style-short')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('door-style-short').click();
  const enter = page.getByTestId('door-enter');
  await expect(enter).toBeVisible({ timeout: 30_000 }); // brain step (box info)
  const startTs = Date.now();
  await enter.click();
  await page.waitForURL(/\/session\/main/, { timeout: 60_000 });

  // first-turn card: mic permission step if the browser wants to ask
  const card = page.getByTestId('first-turn');
  await expect(card).toBeVisible({ timeout: 30_000 });
  const state = await card.getAttribute('data-state');
  if (state === 'mic') {
    await page.getByTestId('first-allow-mic').click();
    await expect(card).toHaveAttribute('data-state', /practice|sent/, { timeout: 30_000 });
  }

  // TALK: two PTT turns (the first may ride the room dial; a person retries)
  await holdTalk(page, 4_000);
  await page.waitForTimeout(8_000);
  await holdTalk(page, 4_000);

  const txt = await pollFresh(page, request, startTs, 120_000);
  expect(txt, 'A: a user transcript landed in MAIN (backend STT alive)').toBeTruthy();
  expect(txt, 'B: the transcript is the fake-mic sentence').toMatch(EXPECT);
  expect(txt, 'C: no baked-in lab wav leaked into STT').not.toMatch(LABMIC_SENTINEL);

  await page.screenshot({ path: '../artifacts/stt-repro-green.png' });
});

/** fresh user voice text in MAIN (server times decide, never the clock) */
async function pollFresh(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  since: number,
  budget: number
): Promise<string | null> {
  const deadline = Date.now() + budget;
  let hit: string | null = null;
  while (Date.now() < deadline) {
    const res = await request.get('/api/session/main/messages?limit=50');
    if (res.ok()) {
      const msgs = (await res.json()) as { role: string; text?: string; time?: number }[];
      const fresh = msgs.filter(
        (m) =>
          m.role === 'user' &&
          (m.text || '').trim() &&
          !HIDDEN.test((m.text || '').trim()) &&
          (m.time || 0) > since
      );
      if (fresh.length) {
        hit = fresh.map((m) => m.text).join(' | ');
        break;
      }
    }
    await page.waitForTimeout(3_000);
  }
  return hit;
}

/** REAL voice, several hands-free turns on MAIN: each spoken turn lands in the preview brain,
 *  is answered, and the app SPEAKS the answer (its /api/tts/stream call returns audio). The live
 *  brain (LIVE_OC_URL, optional) stays untouched. See voice-live-lib.ts for the stack. */
import { expect, test } from '@playwright/test';
import { answered, mainId, msgs, realMic, spoken, ttsLog, voiceTurns } from './voice-live-lib';

realMic('voice-four-turns.wav');
test.setTimeout(240_000);

test('preview MAIN hands-free: several spoken turns land, are answered, and every answer is spoken; live MAIN untouched', async ({
  page,
  request,
}) => {
  const MAIN = await mainId(request);
  const live = process.env.LIVE_OC_URL || '';
  const liveMain = live ? await mainId(request, live).catch(() => undefined) : undefined;
  const live0 = liveMain ? (await msgs(request, liveMain, live)).length : 0;
  const before = (await msgs(request, MAIN)).length;
  const tts = ttsLog(page);
  await page.goto(`/session/main?id=${MAIN}`);
  await expect(page.getByPlaceholder('message…')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('composer-mic').tap(); // tap = hands-free
  const fresh = async () => (await msgs(request, MAIN)).slice(before);
  await expect
    .poll(async () => voiceTurns(await fresh()).length, { timeout: 180_000, intervals: [3000] })
    .toBeGreaterThanOrEqual(3);
  // every answered turn was spoken by the app (give the last one time to start)
  await expect
    .poll(
      async () => {
        const turns = answered(await fresh()).filter((t) => t.reply?.info.time.completed);
        return turns.length > 0 && turns.every((t) => spoken(t.reply!, tts));
      },
      { timeout: 30_000, intervals: [2000] }
    )
    .toBe(true);
  expect(
    tts.filter((t) => t.status !== 200),
    'a TTS call failed'
  ).toEqual([]);
  if (process.env.SHOTS)
    await page.screenshot({ path: `${process.env.SHOTS}/root-coord-preview-handsfree.png` });
  await page.goto('about:blank'); // leaving the session ends hands-free
  if (liveMain) expect((await msgs(request, liveMain, live)).length).toBe(live0);
});

/** REAL voice after reconnect churn (owner 11-13: "nothing goes through if I speak"). Hands-free
 *  on, reload, on again, reload, on again — each join dispatches an agent while the previous one is
 *  still in the room. Before the fix a job whose session closed during that wait stayed in the room
 *  deaf, and every later agent yielded to it. Now the newest agent owns the room: the spoken turns
 *  must land, each answered ONCE, and each answer spoken. */
import { expect, test } from '@playwright/test';
import { answered, mainId, msgs, realMic, spoken, ttsLog, voiceTurns } from './voice-live-lib';

realMic('voice-four-turns.wav');
test.setTimeout(240_000);

test('hands-free survives reconnect churn: turns land, one answer each, every answer spoken', async ({
  page,
  request,
}) => {
  const MAIN = await mainId(request);
  const before = (await msgs(request, MAIN)).length;
  const tts = ttsLog(page);
  const handsFree = async () => {
    await expect(page.getByPlaceholder('message…')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('composer-mic').tap();
  };
  await page.goto(`/session/main?id=${MAIN}`);
  await handsFree();
  await page.waitForTimeout(1500);
  await page.reload(); // the phone leaves mid-dispatch…
  await handsFree();
  await page.waitForTimeout(1000);
  await page.reload(); // …and again
  await handsFree();
  const fresh = async () => (await msgs(request, MAIN)).slice(before);
  await expect
    .poll(async () => voiceTurns(await fresh()).length, { timeout: 180_000, intervals: [3000] })
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(
      async () => {
        const turns = answered(await fresh()).filter((t) => t.reply?.info.time.completed);
        return turns.length >= 2 && turns.every((t) => spoken(t.reply!, tts));
      },
      { timeout: 45_000, intervals: [2000] }
    )
    .toBe(true);
  // one agent answered: no turn got two replies in a row
  const ms = await fresh();
  const doubled = ms.filter(
    (m, i) => m.info.role === 'assistant' && ms[i - 1]?.info.role === 'assistant' && i > 0
  );
  expect(doubled.length, 'two agents answered the same turn').toBe(0);
  expect(
    tts.filter((t) => t.status !== 200),
    'a TTS call failed'
  ).toEqual([]);
  await page.goto('about:blank');
});

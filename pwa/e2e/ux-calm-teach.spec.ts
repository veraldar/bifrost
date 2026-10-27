import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import script from '../lib/onboard-script.json';
import { diag, mainTotal, quietRoom, users, vtMsgs } from './mainframe-c-lib';

/** UX-CALM (10-27, the user: "onboarding should explain how to text, how to
 *  push-to-talk, and how to hands-free with the word 'over' — and ask the user
 *  to actually do each one"). The first-turn card is a walk-through: type →
 *  hold → hands-free + "over", each done once for real, re-walkable from
 *  settings (in the test room, so MAIN is never written).
 *    1 · the whole walk, by voice for real: Chrome's capture path plays a
 *        spoken wav as the mic → lk-agent-ygg → STT (the Mac) → the brain.
 *        Needs the sandbox stack (:8090). Own config: playwright.ux-calm.config.ts
 *    2 · the walk's controls (skip, ✕, resume, ?teach=1) — no voice turn,
 *        runs on the sim (:8096) too. */

// looped, 12.5 s: "what is two plus two?" · silence · "What is three plus three? Over." · 4 s
// (first-turn-en + roots-over-en). Two sentences, not one: the voice agent drops a
// turn identical to its previous one (agent.py last_prompt), so a one-sentence loop
// makes the hands-free turn a copy of the hold and it never lands
const WAV = join(__dirname, 'fixtures/ux-calm-walk-en.wav');

test.use({
  viewport: { width: 360, height: 780 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(process.env.PW_JITLESS ? ['--js-flags=--jitless'] : []),
    ],
  },
});

const SIM = !!process.env.PW_BASE_URL?.includes(':8096');
const SHOTS = process.env.TF_SHOTS || '../artifacts';
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/ux-calm-teach-${name}.png` });

// a returning phone, keyboard mode (the walk is asked for from settings)
async function returning(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('uxc-init')) return;
    sessionStorage.setItem('uxc-init', '1');
    localStorage.setItem('bifrost-door', 'v2');
    localStorage.setItem('bifrost-first-turn', '1');
    localStorage.setItem('bifrost-onboard', JSON.stringify({ lang: 'en', style: 'short' }));
    localStorage.setItem('oz-mode', 'text');
    localStorage.removeItem('bifrost-voice-test');
  });
}

// the reply's speech, without the Mac (the deck's own path): 3 s of tone
async function stubTts(page: Page) {
  const pcm = Buffer.alloc(24000 * 3 * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
  await page.route('**/api/tts/stream', (route) =>
    route.fulfill({ status: 200, contentType: 'application/octet-stream', body: pcm })
  );
}

async function hold(page: Page, ms: number) {
  const b = (await page.getByTestId('composer-mic').boundingBox())!;
  const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await expect(page.locator('.oz-phase')).toHaveText(/heard$/, { timeout: 30_000 });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const ways = (page: Page) =>
  page
    .getByTestId('first-ways')
    .locator('li')
    .evaluateAll((li) => li.map((l) => `${l.getAttribute('data-way')}:${l.getAttribute('data-s')}`));

test('the walk-through: type → hold → hands-free + “over”, each done once, from settings', async ({
  page,
  request,
}) => {
  test.skip(SIM, 'voice turns need the real agent + STT (the sandbox stack)');
  test.setTimeout(420_000);
  console.log(`quiet room after ${await quietRoom('voice-test')}ms`);
  const mainBefore = await mainTotal(request);
  const usersBefore = users(await vtMsgs(request)).length;
  await returning(page);
  await stubTts(page);

  // settings → the three ways → walk it → the test room, the card on "type"
  await page.goto('/settings');
  await page.getByTestId('walk-again').tap();
  await page.waitForURL(/\/session\/voice-test$/, { timeout: 20_000 });
  const card = page.getByTestId('first-turn');
  await expect(card).toHaveAttribute('data-way', 'type');
  await expect(card).toHaveAttribute('data-state', 'practice');
  expect(await ways(page)).toEqual(['type:now', 'hold:todo', 'free:todo']);
  await expect(card).not.toContainText('this is main'); // the test room is not MAIN
  await shot(page, '1-type');

  // 1 · type: the card's button brings the keyboard, the turn lands, the reply
  await page.getByTestId('first-type').tap();
  const ta = page.getByPlaceholder('message…');
  await expect(ta).toBeFocused();
  await ta.pressSequentially('what is two plus two?');
  await page.getByRole('button', { name: 'send', exact: true }).tap();
  await expect(card).toHaveAttribute('data-state', /sent|heard/, { timeout: 15_000 });
  await expect(card).toHaveAttribute('data-state', /heard|practice|mic/, { timeout: 20_000 });
  await expect(card).toHaveAttribute('data-way', 'hold', { timeout: 180_000 });
  expect(await ways(page)).toEqual(['type:done', 'hold:now', 'free:todo']);
  await expect(card).toContainText('hold the mic');
  await shot(page, '2-hold');

  // 2 · hold: talk at "heard", let go — STT proves itself, the reply speaks
  await hold(page, 7_500); // more than one sentence of the loop passes
  await expect(card).toHaveAttribute('data-state', /sent|heard/, { timeout: 10_000 });
  await expect(card).toHaveAttribute('data-state', 'heard', { timeout: 30_000 });
  console.log(`hold heard: ${await page.getByTestId('first-heard').textContent()}`);
  await expect(card).toHaveAttribute('data-way', 'free', { timeout: 180_000 });
  expect(await ways(page)).toEqual(['type:done', 'hold:done', 'free:now']);
  await expect(card).toContainText('tap the mic once');
  await shot(page, '3-free');

  // 3 · hands-free: one tap; the card says what to do there; "over" sends
  await page.getByTestId('composer-mic').tap();
  await expect(page.getByTestId('free-strip')).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('talk, then say “over”');
  await shot(page, '4-free-on');
  await expect(card).toHaveAttribute('data-state', /sent|heard/, { timeout: 60_000 });
  await expect(card).toHaveAttribute('data-state', 'heard', { timeout: 30_000 });
  console.log(`hands-free heard: ${await page.getByTestId('first-heard').textContent()}`);
  await expect(card).toHaveAttribute('data-state', 'in', { timeout: 180_000 });
  await expect(page.getByTestId('first-in')).toHaveText(script.lines.find((l) => l.id === 'in')!.en);
  await shot(page, '5-in');
  // out of hands-free before the looping wav says "over" again
  await page.waitForTimeout(450);
  await page.getByTestId('free-exit').tap({ timeout: 60_000 });
  await expect(ta).toBeVisible();
  await page.getByTestId('first-ok').tap();
  await expect(card).toHaveCount(0);

  const lines = await diag(page);
  for (const re of [
    /first-turn: typed turn landed/,
    /first-turn: transcript \d+ms after release — STT alive/,
    /first-turn: voice turn sent \(free\)/,
    /first-turn: walk-through done/,
  ])
    expect(lines.some((l) => re.test(l)), String(re)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('bifrost-teach'))).toBeNull();
  await page.reload();
  await expect(page.getByTestId('first-turn')).toHaveCount(0); // walked: it stays gone
  // three turns, all in the test room; MAIN untouched
  expect(users(await vtMsgs(request)).length - usersBefore).toBeGreaterThanOrEqual(3);
  expect(await mainTotal(request)).toBe(mainBefore);
});

test('the walk’s controls: ?teach=1 once, resume after a reload, skip each way, ✕ ends it', async ({
  page,
  request,
}) => {
  const name = `e2e-uxcalm-t-${Date.now().toString(36)}`;
  const made = (await (await request.post('/api/session', { data: { name } })).json()) as {
    id: string;
  };
  try {
    await returning(page);
    await page.goto(`/session/${name}?id=${made.id}&teach=1`);
    const card = page.getByTestId('first-turn');
    await expect(card).toHaveAttribute('data-way', 'type');
    // one walk per ask: the param is gone from the address, the walk is kept
    expect(new URL(page.url()).searchParams.get('teach')).toBeNull();
    await page.getByTestId('first-skip').tap();
    await expect(card).toHaveAttribute('data-way', 'hold');
    // a tap on the mic during "hold" is not a turn and not hands-free
    await page.getByTestId('composer-mic').tap();
    await expect(card).toContainText('released — nothing sent');
    await expect(page.getByTestId('free-strip')).toHaveCount(0);
    await page.reload();
    await expect(card).toHaveAttribute('data-way', 'hold'); // resumed, not restarted
    expect(await ways(page)).toEqual(['type:skip', 'hold:now', 'free:todo']);
    await page.getByTestId('first-skip').tap();
    await expect(card).toHaveAttribute('data-way', 'free');
    await page.getByTestId('first-skip').tap();
    await expect(card).toHaveAttribute('data-state', 'in');
    await page.getByTestId('first-ok').tap();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(card).toHaveCount(0);

    // ✕ ends a walk wherever it is
    await page.goto(`/session/${name}?id=${made.id}&teach=1`);
    await expect(card).toHaveAttribute('data-way', 'type');
    await page.getByTestId('first-close').tap();
    await expect(card).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('bifrost-teach'))).toBeNull();
    await page.reload();
    await expect(card).toHaveCount(0);
  } finally {
    await request.delete(`/api/session/${made.id}`);
  }
});

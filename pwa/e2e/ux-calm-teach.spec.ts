import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import script from '../lib/onboard-script.json';
import { diag, mainTotal, quietRoom, users, vtMsgs } from './mainframe-c-lib';

/** UX-CALM (10-27, the user: "onboarding should explain how to text, how to
 *  push-to-talk, and how to hands-free with the word 'over' — and ask the user
 *  to actually do each one"). The first-turn card is a walk-through: type →
 *  hold → hands-free + "over", each done once for real, re-walkable from
 *  settings (in the test room, so MAIN is never written).
 *    1 · the whole walk, by voice for real: the mic is a scripted stream the
 *        spec speaks into on cue (a wav per step) → LiveKit → lk-agent-ygg →
 *        STT (the Mac) → the brain.
 *        Needs the sandbox stack (:8090). Own config: playwright.ux-calm.config.ts
 *    2 · the walk's controls (skip, ✕, resume, ?teach=1) — no voice turn,
 *        runs on the sim (:8096) too. */

// the two things the user says, one per voice way — different on purpose: the
// voice agent drops a turn identical to its previous one (lane2-merge agent.py
// last_prompt), and a looping capture file makes every "over" commit the same
// text. A: the hold ("what is two plus two?"), B: hands-free ("What is three
// plus three? Over.")
const SAY_A = readFileSync(join(__dirname, 'fixtures/first-turn-en.wav')).toString('base64');
const SAY_B = readFileSync(join(__dirname, 'fixtures/roots-over-en.wav')).toString('base64');

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

// the mic: getUserMedia hands out a track of one WebAudio destination, silent
// until the spec says something into it (window.__say, a base64 wav) — the
// same capture path the app always takes, the words chosen per step
async function scriptedMic(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __say: (b64: string) => Promise<number> };
    let ctx: AudioContext | null = null;
    let out: MediaStreamAudioDestinationNode | null = null;
    const ensure = () => {
      if (!ctx) {
        ctx = new AudioContext();
        out = ctx.createMediaStreamDestination();
      }
      return ctx;
    };
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (!c || !c.audio) return orig(c);
      const ac = ensure();
      if (ac.state === 'suspended') await ac.resume().catch(() => {});
      return new MediaStream([out!.stream.getAudioTracks()[0].clone()]);
    };
    w.__say = async (b64: string) => {
      const ac = ensure();
      if (ac.state === 'suspended') await ac.resume().catch(() => {});
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const buf = await ac.decodeAudioData(bytes.buffer);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(out!);
      src.start();
      return buf.duration;
    };
  });
}
const say = (page: Page, b64: string) =>
  page.evaluate((b) => (window as unknown as { __say: (b: string) => Promise<number> }).__say(b), b64);

// the reply's speech, without the Mac (the deck's own path): 3 s of tone
async function stubTts(page: Page) {
  const pcm = Buffer.alloc(24000 * 3 * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
  await page.route('**/api/tts/stream', (route) =>
    route.fulfill({ status: 200, contentType: 'application/octet-stream', body: pcm })
  );
}

// a hold as a finger does it: press, talk at "heard", let go after the words
async function holdAndSay(page: Page, b64: string) {
  const b = (await page.getByTestId('composer-mic').boundingBox())!;
  const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await expect(page.locator('.oz-phase')).toHaveText(/heard$/, { timeout: 30_000 });
  const secs = await say(page, b64);
  await page.waitForTimeout(Math.round(secs * 1000) + 800);
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
  await scriptedMic(page);
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
  await holdAndSay(page, SAY_A); // "what is two plus two?"
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
  await expect(page.getByTestId('free-phase')).toHaveAttribute('data-cycle', 'listening');
  await page.waitForTimeout(1_500); // the agent's ear: the hands-free mic opens
  await say(page, SAY_B); // "What is three plus three? Over."
  await expect(card).toHaveAttribute('data-state', /sent|heard/, { timeout: 30_000 });
  await expect(card).toHaveAttribute('data-state', 'heard', { timeout: 30_000 });
  console.log(`hands-free heard: ${await page.getByTestId('first-heard').textContent()}`);
  await expect(card).toHaveAttribute('data-state', 'in', { timeout: 180_000 });
  await expect(page.getByTestId('first-in')).toHaveText(script.lines.find((l) => l.id === 'in')!.en);
  await shot(page, '5-in');
  // out of hands-free: the walk is done, the mic need not stay open
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

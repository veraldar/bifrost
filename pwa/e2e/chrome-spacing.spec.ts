import { appendFileSync, mkdirSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';

/** UX-SPACING (10-27): the chrome holds still. One header height on every
 *  page; the session footer (dock + phase line) reserves the same box in every
 *  voice state, so nothing jumps when the words come and go (idle = nothing,
 *  working = no words, 9f43c8e / 4028224). The S22 is the phone (360×780).
 *  SPACING_TAG=<tag> also writes phone shots + one json line per measurement
 *  to $SPACING_OUT (default ../artifacts) as ux-spacing-<tag>-<page>-<state>.
 *  Works on the real brain and on the sim's mock ("sleep N" holds the turn). */
const TAG = process.env.SPACING_TAG || '';
const OUT = process.env.SPACING_OUT || '../artifacts';
if (TAG) mkdirSync(OUT, { recursive: true });

const S22 = { width: 360, height: 780 };
test.use({ viewport: S22, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

type Box = { top: number; h: number; bottom: number } | null;
type Chrome = {
  vw: number;
  vh: number;
  head: Box;
  under: Box; // the first thing under the header: rail (session) / band (home)
  body: Box; // the transcript scroller (session) / the list's main (home)
  dock: Box;
  phase: Box;
  roots: Box;
  safe: number; // env(safe-area-inset-bottom) as this browser resolves it
  words: string;
  clipped: boolean; // the words overflow their line (cut or wrapped)
};

const chrome = (page: Page): Promise<Chrome> =>
  page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const r = (n: number) => Math.round(n * 10) / 10;
      return { top: r(b.top), h: r(b.height), bottom: r(b.bottom) };
    };
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;padding-bottom:env(safe-area-inset-bottom,0px)';
    document.body.appendChild(probe);
    const safe = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    probe.remove();
    return {
      vw: innerWidth,
      vh: innerHeight,
      head: box('header.oz-head'),
      under: box('header.oz-head + .oz-rail') ?? box('figure.oz-band'),
      body: box('main > .overflow-y-auto') ?? box('main'),
      dock: box('.oz-dock'),
      phase: box('.oz-phase'),
      roots: box('.oz-roots'),
      safe,
      words: document.querySelector('.oz-phase')?.textContent?.trim() ?? '',
      clipped: [...document.querySelectorAll('.oz-phase > span')].some(
        (el) =>
          el.scrollWidth > el.clientWidth + 1 ||
          el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight) * 1.5
      ),
    };
  });

async function record(page: Page, where: string, state: string): Promise<Chrome> {
  const c = await chrome(page);
  if (TAG) {
    appendFileSync(`${OUT}/ux-spacing-${TAG}.jsonl`, JSON.stringify({ where, state, ...c }) + '\n');
    await page.screenshot({ path: `${OUT}/ux-spacing-${TAG}-${where}-${state}.png` });
  }
  return c;
}

// the footer's frame: where the dock starts, where the phase line ends
const frame = (c: Chrome) => ({
  dockTop: c.dock?.top,
  phaseBottom: c.phase?.bottom,
  bodyBottom: c.body?.bottom,
});

// every session a test opens is deleted after it — a list that grows run by
// run pushes the roots out of mainframe-c-roots' 40-Tab reach
const made: string[] = [];
test.afterEach(async ({ page }) => {
  for (const id of made.splice(0)) await page.request.delete(`/api/session/${id}`);
});

async function newSession(page: Page, name: string): Promise<string> {
  const r = await page.request.post('/api/session', { data: { name } });
  expect(r.ok()).toBe(true);
  const j = (await r.json()) as { id?: string };
  if (j.id) made.push(j.id);
  return `/session/${name}${j.id ? `?id=${j.id}` : ''}`;
}

// a hold on the composer mic as a finger does it (CDP touch, not a mouse);
// one CDP session per gesture — a fresh one forgets the touch that started it
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  return { send, done: () => cdp.detach() };
}

test('the header is one height on every page', async ({ page }) => {
  const sess = await newSession(page, `e2e-spacing-h-${Date.now().toString(36)}`);
  const pages: [string, string][] = [
    ['home', '/'],
    ['session', sess],
    ['main', '/session/main'],
    ['settings', '/settings'],
    ['artifacts', '/artifacts'],
    ['session-settings', `${sess.split('?')[0]}/settings`],
  ];
  const heights: Record<string, number | undefined> = {};
  for (const [where, url] of pages) {
    await page.goto(url);
    await expect(page.locator('header.oz-head')).toBeVisible();
    await page.waitForTimeout(400);
    const c = await record(page, where, 'idle');
    heights[where] = c.head?.h;
    expect.soft(c.head?.top, `${where}: the header starts at the top`).toBe(0);
  }
  const all = new Set(Object.values(heights));
  expect.soft(all.size, `header heights ${JSON.stringify(heights)}`).toBe(1);
});

test('jump: idle → working → idle, the footer frame never moves', async ({ page }) => {
  await page.goto(await newSession(page, `e2e-spacing-j-${Date.now().toString(36)}`));
  await expect(page.getByPlaceholder('message…')).toBeVisible();
  await page.waitForTimeout(400);
  const idle = await record(page, 'session', 'idle');

  // "sleep 6" holds the mock's first chunk; a real brain is busy a while anyway
  await page.getByPlaceholder('message…').fill('sleep 6 — reply with exactly: spacing');
  await page.getByRole('button', { name: 'send', exact: true }).tap();
  await expect(page.getByText(/working… \d+s/)).toBeVisible();
  await page.waitForTimeout(300);
  const working = await record(page, 'session', 'working');
  expect.soft(working.words, 'working says nothing in the phase line').toBe('');

  await expect(page.getByText(/working… \d+s/)).toHaveCount(0, { timeout: 90_000 });
  await page.waitForTimeout(400);
  const after = await record(page, 'session', 'idle-after');

  expect.soft(frame(working), 'working vs idle').toEqual(frame(idle));
  expect.soft(frame(after), 'idle again vs idle').toEqual(frame(idle));
});

test('every voice state keeps the footer box', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP touch');
  // a short fake reply for the deck: 6 s of a quiet 220 Hz tone, 24 kHz s16le
  const pcm = Buffer.alloc(24000 * 6 * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
  await page.route('**/api/tts/stream', async (route) => {
    await new Promise((r) => setTimeout(r, 1500)); // a visible "synthesizing"
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: pcm });
  });

  await page.goto(await newSession(page, `e2e-spacing-v-${Date.now().toString(36)}`));
  const ta = page.getByPlaceholder('message…');
  await expect(ta).toBeVisible();
  await page.waitForTimeout(400);
  const idle = await record(page, 'voice', 'idle');
  const seen: Record<string, ReturnType<typeof frame> & { phaseH?: number; words: string }> = {};
  const keep = (state: string, c: Chrome) => {
    seen[state] = { ...frame(c), phaseH: c.phase?.h, words: c.words };
    expect
      .soft(c.clipped, `${state}: every word on one line at ${c.vw}px ("${c.words}")`)
      .toBe(false);
  };
  keep('idle', idle);

  // a reply to play: the listen chip sits on the last agent message
  await ta.fill('reply with exactly: the deck plays this line');
  await page.getByRole('button', { name: 'send', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'listen' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'listen' }).tap();
  // the deck says synthesizing / speaking — the line stays empty (ux-calm: said once)
  await expect(page.locator('.oz-deck')).toContainText('synthesizing', { timeout: 5_000 });
  keep('synthesizing', await record(page, 'voice', 'synthesizing'));
  await expect(page.locator('.oz-deck')).toContainText('speaking', { timeout: 15_000 });
  keep('speaking', await record(page, 'voice', 'speaking'));
  await page.getByRole('button', { name: 'stop speaking' }).tap();
  await expect(page.locator('.oz-phase')).toHaveText('', { timeout: 5_000 });

  // push-to-talk: hold the mic until the room says "heard", slide into delete
  const mic = (await page.getByTestId('composer-mic').boundingBox())!;
  const [mx, my] = [mic.x + mic.width / 2, mic.y + mic.height / 2];
  const f = await finger(page);
  await f.send('touchStart', mx, my);
  await expect(page.locator('.oz-phase')).toHaveText(/heard$/, { timeout: 30_000 });
  await page.waitForTimeout(300);
  keep('heard', await record(page, 'voice', 'heard'));
  await f.send('touchMove', mx - 32, my);
  await expect(page.locator('.oz-phase')).toHaveText(/delete$/);
  keep('drop', await record(page, 'voice', 'drop'));
  await f.send('touchEnd');
  await f.done();
  await expect(page.locator('.oz-phase')).toHaveText('', { timeout: 10_000 });

  // hands-free: a quick tap on the same mic; the strip replaces the composer
  await page.getByTestId('composer-mic').tap();
  await expect(page.getByTestId('free-phase')).toHaveText(/hands-free$/, { timeout: 30_000 });
  await page.waitForTimeout(600); // past the 400 ms ghost guard, or the exit tap is eaten
  keep('hands-free', await record(page, 'voice', 'hands-free'));
  await page.getByTestId('free-exit').tap();
  await expect(page.getByPlaceholder('message…')).toBeVisible();

  for (const [state, f] of Object.entries(seen)) {
    expect.soft(f.dockTop, `${state} dock top (words: "${f.words}")`).toBe(seen.idle.dockTop);
    expect
      .soft(f.phaseH, `${state} phase line height (words: "${f.words}")`)
      .toBe(seen.idle.phaseH);
    expect.soft(f.phaseBottom, `${state} phase line bottom`).toBe(seen.idle.phaseBottom);
  }
});

test('MAIN and a session share the footer; onboarding adds content, not chrome', async ({
  page,
}) => {
  const sess = await newSession(page, `e2e-spacing-m-${Date.now().toString(36)}`);
  await page.goto(sess);
  await expect(page.getByPlaceholder('message…')).toBeVisible();
  await page.waitForTimeout(400);
  const s = await record(page, 'session', 'done-device');

  await page.goto('/session/main');
  await expect(page.locator('.oz-dock')).toBeVisible();
  await page.waitForTimeout(600);
  const m = await record(page, 'main', 'done-device');

  // an onboarding device: the door walked, its first voice turn not yet
  await page.evaluate(() => localStorage.removeItem('bifrost-first-turn'));
  await page.reload();
  await expect(page.getByTestId('first-turn')).toBeVisible();
  await page.waitForTimeout(600);
  const o = await record(page, 'main', 'onboarding');
  await page.evaluate(() => localStorage.setItem('bifrost-first-turn', '1'));

  expect.soft(m.head, 'MAIN header vs session header').toEqual(s.head);
  expect.soft(frame(m), 'MAIN footer vs session footer').toEqual(frame(s));
  expect.soft(o.dock, 'onboarding dock vs done dock').toEqual(m.dock);
  expect.soft(o.phase, 'onboarding phase vs done phase').toEqual(m.phase);

  // the front page: header on top, the roots on the ground
  await page.goto('/');
  await expect(page.getByTestId('roots')).toBeVisible();
  await page.waitForTimeout(400);
  const h = await record(page, 'home', 'done-device');
  expect.soft(h.head?.h, 'home header vs session header').toBe(s.head?.h);
  expect.soft(h.roots?.bottom, 'the roots sit on the ground').toBe(h.vh);
});

for (const width of [412, 430, 1280]) {
  test(`widths: ${width}px keeps the same chrome`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 500 ? 800 : 915 });
    const sess = await newSession(page, `e2e-spacing-w-${Date.now().toString(36)}`);
    const got: Record<string, Chrome> = {};
    for (const [where, url] of [
      ['home', '/'],
      ['session', sess],
    ] as const) {
      await page.goto(url);
      await expect(page.locator('header.oz-head')).toBeVisible();
      await page.waitForTimeout(400);
      got[where] = await record(page, `${where}-w${width}`, 'idle');
    }
    expect.soft(got.home.head?.h).toBe(got.session.head?.h);
    expect.soft(got.session.phase?.bottom, 'the footer reaches the ground').toBe(got.session.vh);
  });
}

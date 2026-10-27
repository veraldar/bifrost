import { type Page, expect, test } from '@playwright/test';

/** UX-CALM (10-27, the user's voice order):
 *   1 · "as long as you're working, I shouldn't be able to tap the listen
 *       button" — a real run, sampled every frame: while the header's working
 *       dot is up there is no listen chip, even once the reply's words are on
 *       screen; the chip comes when the run is idle and plays the reply.
 *   2 · "all those help texts — I want all of them gone" — the session footer
 *       (dock, deck, phase line, history chip) is watched by a
 *       MutationObserver through every voice state, in all three modes; every
 *       text it ever showed is state, never teaching.
 *  The teaching moved into the first-turn walk-through: ux-calm-teach.spec.ts.
 *  Works on the real brain (:8090) and on the sim's mock (:8096). */

const S22 = { width: 360, height: 780 };
test.use({
  viewport: S22,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  permissions: ['microphone'],
});

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

// the reply's speech, without the Mac: 6 s of a 220 Hz tone, after a visible
// "synthesizing" (the deck's own path — fetch, decode, play)
async function stubTts(page: Page) {
  const pcm = Buffer.alloc(24000 * 6 * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
  await page.route('**/api/tts/stream', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: pcm });
  });
}

// a finger on the glass (CDP touch, not a mouse — the phone's ghost click only
// exists with touch); one CDP session per gesture
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  return { send, done: () => cdp.detach() };
}

type Sample = { t: number; busy: boolean; reply: boolean; chip: boolean };

test('busy law: no listen chip to tap while the run is in flight — it comes at idle and plays', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await stubTts(page);
  await page.goto(await newSession(page, `e2e-uxcalm-l-${Date.now().toString(36)}`));
  const ta = page.getByPlaceholder('message…');
  await expect(ta).toBeVisible();

  // every frame: is it working (the header's breathing dot), is the agent's
  // reply on screen, is there a listen chip? (.oz-chip + "listen" — the same
  // selector on builds before and after the law, for the RED baseline)
  await page.evaluate(() => {
    const w = window as unknown as { __s: Sample[] };
    w.__s = [];
    const tick = () => {
      w.__s.push({
        t: Math.round(performance.now()),
        busy: !!document.querySelector('header [aria-label="working"]'),
        reply: [...document.querySelectorAll('[data-mi] .oz-who')].some((e) =>
          (e.textContent || '').includes('(agent)')
        ),
        chip: [...document.querySelectorAll('button.oz-chip')].some((b) =>
          /\blisten\b/.test(b.textContent || '')
        ),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // a reply long enough to stream for a while (the mock: "slow …" streams ~10 s)
  await ta.fill(
    process.env.PW_BASE_URL?.includes(':8096')
      ? 'slow count to forty'
      : 'Write the numbers one to forty in words, one per line. Nothing else.'
  );
  await page.getByRole('button', { name: 'send', exact: true }).tap();
  const dot = page.locator('header [aria-label="working"]');
  await expect(dot).toBeVisible({ timeout: 15_000 });
  // while it works: no chip, every time we look (on top of the frame sampler)
  const chip = page.locator('button.oz-chip', { hasText: 'listen' });
  const until = Date.now() + 150_000;
  while ((await dot.count()) > 0 && Date.now() < until) {
    expect(await chip.count(), 'listen chip while working').toBe(0);
    await page.waitForTimeout(100);
  }
  await expect(dot).toHaveCount(0);
  const idleAt = await page.evaluate(() => Math.round(performance.now()));
  await expect(chip).toBeVisible({ timeout: 5_000 });

  const s = await page.evaluate(() => (window as unknown as { __s: Sample[] }).__s);
  const busy = s.filter((x) => x.busy);
  const tapped = busy.filter((x) => x.chip);
  const replyWhileBusy = busy.filter((x) => x.reply);
  const firstChip = s.find((x) => x.chip && x.t >= (busy.at(-1)?.t ?? 0));
  console.log(
    `busy law: ${s.length} frames, ${busy.length} working, ${replyWhileBusy.length} with the reply ` +
      `on screen while working, ${tapped.length} with a chip while working; chip ` +
      `${firstChip ? firstChip.t - (busy.at(-1)?.t ?? 0) : '?'} ms after the dot went (idle at ${idleAt})`
  );
  // the user's scenario happened: the reply's words were there while it worked…
  expect(replyWhileBusy.length, 'reply on screen while still working').toBeGreaterThan(0);
  // …and in none of those frames was there anything to tap
  expect(tapped.length, 'frames with a listen chip while working').toBe(0);

  // idle: the chip plays the reply (the deck takes over, its red ■ stops it)
  await chip.tap();
  await expect(page.locator('.oz-deck')).toBeVisible({ timeout: 5_000 });
  await expect(chip).toHaveCount(0);
  await page.getByRole('button', { name: /^stop/ }).tap();
  await expect(chip).toBeVisible({ timeout: 10_000 });
});

/** every text the footer ever shows: text nodes under the dock, the deck, the
 *  phase line and the history chip — the textarea's own value is the user's */
const WATCH = `() => {
  const w = window;
  w.__footer = new Set();
  const sel = '.oz-dock, .oz-deck, .oz-phase, [data-testid="hist-chip"]';
  const grab = () => {
    for (const root of document.querySelectorAll(sel)) {
      const parts = [];
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (n.parentElement && n.parentElement.closest('textarea, input')) continue;
        const t = (n.textContent || '').trim();
        if (t) parts.push(t);
      }
      const line = parts.join(' ').replace(/\\s+/g, ' ').trim();
      if (line) w.__footer.add((root.className.split(' ')[0] || root.dataset.testid) + ': ' + line);
    }
  };
  new MutationObserver(grab).observe(document.body, { subtree: true, childList: true, characterData: true });
  grab();
}`;

// teaching = an instruction to the user about a control or a gesture
const TEACH =
  /\b(say|tap|tapping|release|slide|hold|holding|keep|talk|type|send|stops?|returns|press|swipe)\b|to send|to delete|to keep|back to|“over”|"over"/i;
// the phase line's whole vocabulary — state words only
const PHASE_WORDS = new Set(['opening the mic…', 'heard', 'delete', 'hands-free']);

test('zero help text: the footer says state only — text, push-to-talk and hands-free', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await stubTts(page);
  await page.goto(await newSession(page, `e2e-uxcalm-f-${Date.now().toString(36)}`));
  const ta = page.getByPlaceholder('message…');
  await expect(ta).toBeVisible();
  await page.evaluate(`(${WATCH})()`);
  const phase = page.locator('.oz-phase');
  const seen: Record<string, string[]> = {};
  const snap = async (mode: string) => {
    const all = await page.evaluate(() => [...(window as unknown as { __footer: Set<string> }).__footer]);
    seen[mode] = all.filter((x) => !Object.values(seen).flat().includes(x));
  };

  // ── text: idle → working → the reply → listen (synthesizing, speaking) → stop
  await ta.fill(
    process.env.PW_BASE_URL?.includes(':8096') ? 'reply with exactly: calm' : 'Reply with exactly: calm'
  );
  await page.getByRole('button', { name: 'send', exact: true }).tap();
  await expect(page.locator('header [aria-label="working"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('listen-chip')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('listen-chip').tap();
  await expect(page.locator('.oz-deck')).toContainText('synthesizing', { timeout: 5_000 });
  await expect(page.locator('.oz-deck')).toContainText('speaking', { timeout: 15_000 });
  await page.getByRole('button', { name: 'stop speaking' }).tap();
  await expect(page.locator('.oz-deck')).toHaveCount(0, { timeout: 5_000 });
  // the history chip: ↑ recalls the sent line
  await ta.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('hist-chip')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('hist-chip')).toHaveCount(0);
  await snap('text');

  // ── push-to-talk: hold until "heard", slide into delete, let go there
  const mic = (await page.getByTestId('composer-mic').boundingBox())!;
  const [mx, my] = [mic.x + mic.width / 2, mic.y + mic.height / 2];
  const f = await finger(page);
  await f.send('touchStart', mx, my);
  await expect(phase).toHaveText(/heard$/, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await f.send('touchMove', mx - 32, my);
  await expect(phase).toHaveAttribute('data-s', 'drop');
  await expect(phase).toHaveText(/delete$/);
  await f.send('touchEnd');
  await f.done();
  await expect(phase).toHaveText('', { timeout: 10_000 });
  await snap('ptt');

  // ── hands-free: a tap on the same mic; connecting → listening (the bars)
  await page.getByTestId('composer-mic').tap();
  const free = page.getByTestId('free-phase');
  await expect(free).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('free-strip')).not.toContainText('connecting', { timeout: 30_000 });
  await expect(free).toHaveText(/hands-free$/);
  await page.waitForTimeout(600); // past the 400 ms ghost guard, or the exit is eaten
  await page.getByTestId('free-exit').tap();
  await expect(ta).toBeVisible();
  await snap('hands-free');

  console.log(`footer texts seen:\n${JSON.stringify(seen, null, 1)}`);
  const all = Object.values(seen).flat();
  expect(all.length, 'the observer saw the footer').toBeGreaterThan(3);
  for (const t of all) expect.soft(t, 'footer text is state, not teaching').not.toMatch(TEACH);
  // the phase line, word for word: nothing outside the state vocabulary
  for (const t of all.filter((x) => x.startsWith('oz-phase: '))) {
    const words = t.slice('oz-phase: '.length).replace(/^[○◉●▸×]\s*/, '');
    expect.soft(PHASE_WORDS.has(words), `phase line "${words}" is a state word`).toBe(true);
  }
  // each mode showed its own state at least once
  expect(seen.ptt.some((t) => /oz-phase: ◉ heard/.test(t)), 'ptt: heard').toBe(true);
  expect(seen.ptt.some((t) => /oz-phase: × delete/.test(t)), 'ptt: delete').toBe(true);
  expect(seen['hands-free'].some((t) => /oz-phase: .* hands-free/.test(t)), 'hands-free').toBe(true);
});

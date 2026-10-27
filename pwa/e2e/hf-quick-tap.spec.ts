import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

/** HF-CLICK (req 10-27): ONE tap on the composer mic turns hands-free on —
 *  and it STAYS on. The user's words: "I see the mic opening, but it closes
 *  very quickly, and hands-free never starts". The sandbox diag had every tap
 *  as a 'leave hands-free' click: entering hands-free swaps the mic for the
 *  free dock, its exit sits exactly where the mic was, and the lift's
 *  synthesized click lands on it (the 10-02 09:38 ghost, back).
 *
 *  A mouse click never shows this — its click goes to the pressed element —
 *  so the gesture here is a real TOUCH, the way a thumb taps: touchStart,
 *  a beat, touchEnd, and Chrome synthesizes the click from the tap, hit-tested
 *  after the dock swapped, exactly like the phone. Two presses: the quick
 *  click (<150 ms, the user's) and the slow human tap (300 ms — past the
 *  250 ms PTT arm, the 10-02 09:16 tap-arm race). Both must toggle, neither
 *  may send a turn, and a real tap on the exit afterwards still leaves. */
const NAME = `e2e-hfclick-${Date.now().toString(36)}`;
let sessionId = '';

test.use({ hasTouch: true, isMobile: true });

test.beforeAll(async ({ request }) => {
  sessionId = (await (await request.post('/api/session', { data: { name: NAME } })).json()).id;
});
test.afterAll(async ({ request }) => {
  if (sessionId) await request.delete(`/api/session/${sessionId}`);
});

type Mark = { k: string; v: string; t: number };
/** every frame: is hands-free up, is the PTT pill up — plus every pointer
 *  event and click with the button it landed on, stamped */
async function filmstrip(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __m: Mark[] };
    w.__m = [];
    const last: Record<string, string> = {};
    const put = (k: string, v: string) => {
      if (last[k] === v) return;
      last[k] = v;
      w.__m.push({ k, v, t: performance.now() });
    };
    const tick = () => {
      put('free', document.querySelector('[data-testid="free-phase"]') ? 'on' : 'off');
      put('pill', document.querySelector('.oz-dock [role="status"]') ? 'on' : 'off');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    for (const type of ['pointerdown', 'pointerup', 'click'])
      document.addEventListener(
        type,
        (e) => {
          const el = (e.target as Element | null)?.closest?.('button');
          w.__m.push({ k: type, v: el?.getAttribute('aria-label') ?? '-', t: performance.now() });
        },
        true
      );
  });
}
const marks = (page: Page) => page.evaluate(() => (window as unknown as { __m: Mark[] }).__m);
const now = (page: Page) => page.evaluate(() => performance.now());
const total = async (request: APIRequestContext) =>
  Number(
    (await request.get(`/api/session/${sessionId}/messages?limit=1`)).headers()['x-total-count'] ||
      0
  );

/** a thumb on the glass: touchStart, hold `ms`, touchEnd — the click is the browser's */
async function touchTap(page: Page, sel: ReturnType<Page['getByRole']>, ms: number) {
  const b = (await sel.boundingBox())!;
  const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// `arms`: the press outlives the 250 ms PTT arm — the mic may open for the
// rest of it, then the release reinterprets the press as the tap it was
for (const { press, ms, limit, arms } of [
  { press: 'quick click', ms: 90, limit: 150, arms: false },
  { press: 'slow human tap', ms: 300, limit: 400, arms: true },
]) {
  test(`one ${press} (<${limit} ms) turns hands-free on and it stays on`, async ({
    page,
    request,
  }) => {
    await filmstrip(page);
    const token = page.waitForResponse('**/api/token');
    await page.goto(`/session/${NAME}?id=${sessionId}`);
    const mic = page.getByRole('button', { name: 'push to talk' });
    await expect(mic).toBeVisible();
    // the user taps a settled screen: the room preconnected, the idle words up
    await token;
    await expect(mic).not.toHaveClass(/opacity-50/, { timeout: 30_000 });
    await expect(page.locator('.oz-phase')).toContainText('tap it for hands-free');
    await page.waitForTimeout(500);
    const msgsBefore = await total(request);

    const t0 = await now(page);
    await touchTap(page, mic, ms);
    // the tap, its synthesized click, and the 2 s hands-free must then hold —
    // filmed, not polled: a ghost exit + re-entry would pass a final check
    await page.waitForTimeout(2_700);
    const free = page.getByTestId('free-phase');

    const m = (await marks(page)).filter((x) => x.t >= t0);
    const tl = m.map((x) => `${Math.round(x.t - t0)}ms ${x.k}=${x.v}`).join(' · ');
    console.log(`[${press}] ${tl}`);
    // the gesture really was this press: one pointer, down→up inside the limit
    const down = m.find((x) => x.k === 'pointerdown')!;
    const up = m.find((x) => x.k === 'pointerup')!;
    expect(down.v, tl).toBe('push to talk');
    expect(up.t - down.t, tl).toBeLessThan(limit);
    // hands-free came up ONCE and never went away (a ghost exit = on → off)
    expect(
      m.filter((x) => x.k === 'free').map((x) => x.v),
      tl
    ).toEqual(['on']);
    const onAt = m.find((x) => x.k === 'free')!.t;
    expect((await now(page)) - onAt, tl).toBeGreaterThanOrEqual(2_000);
    await expect(free).toBeVisible();
    // a quick click never reaches the hold path: no PTT pill, no mic armed
    if (!arms)
      expect(
        m.filter((x) => x.k === 'pill'),
        tl
      ).toEqual([]);
    // a tap is not a turn: nothing went out to the session
    expect(await total(request), tl).toBe(msgsBefore);

    // the guard swallows only the gesture's own ghost — a real tap on the
    // exit (past its window) still leaves hands-free
    await touchTap(page, page.getByRole('button', { name: 'leave hands-free' }), ms);
    await expect(free).toHaveCount(0);
    await expect(mic).toBeVisible();
  });
}

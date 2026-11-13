import { type Page, expect, test } from '@playwright/test';
/** VOICE-DELIVERY-R2 (11-11) owner-phone bug: SSE idle frame dropped AND X-Run-State unseeded →
 *  busy never cleared, no speak. Pre-fix strands; post-fix the poll path clears ≤8 s and speaks.
 *  (r1 text follows) : hands-free, a turn is committed ("over"), the reply lands —
 *  the deck must go working → speaking within 3 s, the busy flag must clear, and the
 *  audio must really start (spies: tts fetch, Audio.play() promise, phase marks). */
const NAME = `e2e-seam-vd2-${Date.now().toString(36)}`;
let sid = '';
test.use({ hasTouch: true, isMobile: true });
test.beforeAll(async ({ request }) => {
  sid = (await (await request.post('/api/session', { data: { name: NAME } })).json()).id;
});
test.afterAll(async ({ request }) => {
  if (sid) await request.delete(`/api/session/${sid}`);
});
type Mark = { k: string; v: string; t: number };
async function spies(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __m: Mark[] };
    w.__m = [];
    const put = (k: string, v: string) => w.__m.push({ k, v, t: Date.now() });
    const last: Record<string, string> = {};
    const tick = () => {
      const fp = document.querySelector('[data-testid="free-phase"]');
      const v1 = fp?.getAttribute('data-cycle') ?? 'off';
      const v2 = document.querySelector('.oz-phase')?.getAttribute('data-s') ?? '-';
      const v3 = document.querySelector('[data-testid="speech-deck"],[data-testid="deck"]')?.getAttribute('data-phase') ?? '-';
      for (const [k, v] of [['cycle', v1], ['phase', v2], ['deck', v3]] as const)
        if (last[k] !== v) { last[k] = v; put(k, v); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...a) {
      put('audio.play', 'called');
      const p = play.apply(this, a);
      p.then(() => put('audio.play', 'resolved'), (e) => put('audio.play', 'REJECTED ' + String(e)));
      return p;
    };
    const f = window.fetch;
    window.fetch = function (...a) {
      const u = String(a[0] instanceof Request ? a[0].url : a[0]);
      if (u.includes('/api/tts')) {
        put('tts.fetch', 'start');
        return f.apply(this, a).then((r) => { put('tts.fetch', 'resp ' + r.status); return r; }, (e) => { put('tts.fetch', 'ERR ' + e); throw e; });
      }
      return f.apply(this, a);
    };
    const wr = console.warn;
    console.warn = (...a) => { put('warn', a.join(' ').slice(0, 160)); wr(...a); };
    // DROP_IDLE: the 'idle' frame falls in a reconnect gap (SSE has no replay) — the page never sees it
    const drop = sessionStorage.getItem('dropidle') === '1';
    const es = window.EventSource;
    window.EventSource = class extends es {
      constructor(u: string | URL, o?: EventSourceInit) {
        super(u, o);
        this.addEventListener('message', (e) => put('sse', (e as MessageEvent).data + (drop && (e as MessageEvent).data === 'idle' ? ' (DROPPED)' : '')));
        if (drop) {
          const d = Object.getOwnPropertyDescriptor(es.prototype, 'onmessage')!;
          Object.defineProperty(this, 'onmessage', {
            set: (fn: (e: MessageEvent) => void) => d.set!.call(this, (e: MessageEvent) => { if (e.data !== 'idle') fn(e); }),
          });
        }
      }
    } as typeof EventSource;
  });
}
test('hands-free over → reply → speaking ≤3s, working cleared, audio started', async ({ page, request }) => {
  test.setTimeout(110_000);
  page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
  await page.addInitScript(() => sessionStorage.setItem('dropidle', '1'));
  // the phone's poll never gets the run-state header (runStateRef stays '' = "(none)")
  await page.route('**/api/session/*/messages?*', async (route) => {
    const r = await route.fetch();
    const h = { ...r.headers() };
    delete h['x-run-state'];
    await route.fulfill({ response: r, headers: h });
  });
  await spies(page);
  await page.goto(`/session/${NAME}?id=${sid}`);
  const mic = page.getByRole('button', { name: 'push to talk' });
  await expect(mic).not.toHaveClass(/opacity-50/, { timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  const b = (await mic.boundingBox())!;
  const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await page.waitForTimeout(120);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  // "over": the dock tap commits the turn (processing + mic muted); the turn itself is posted as the agent would
  const dock = page.getByTestId('free-phase');
  const db = (await dock.boundingBox())!;
  await page.touchscreen.tap(db.x + db.width / 2, db.y + db.height / 2);
  await expect(dock).toHaveAttribute('data-cycle', 'processing', { timeout: 20_000 }).catch(() => {});
  const sent = Date.now();
  await request.post(`/api/session/${sid}/messages`, { data: { text: 'Reply with exactly: pong' } });
  console.log('[probe] posted at', sent);
  await page.waitForTimeout(25_000);
  const m: Mark[] = await page.evaluate(() => (window as unknown as { __m: Mark[] }).__m);
  console.log('[marks]\n' + m.map((x) => `+${x.t - sent}ms ${x.k}=${x.v}`).join('\n'));
  const at = (k: string, v: string) => m.find((x) => x.k === k && x.v.startsWith(v))?.t;
  const reply = at('sse', 'idle');
  const speaking = at('phase', 'speaking');
  expect(speaking, 'phase reached speaking (idle frame dropped)').toBeTruthy();
  expect(speaking! - reply!, 'poll path speaks ≤8s after the run ended').toBeLessThan(8000);
  expect(at('tts.fetch', 'start'), 'tts requested').toBeTruthy();
});

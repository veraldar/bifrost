import { type Page, expect, test } from '@playwright/test';
/** NO DEAD AIR (FILM-V1, 10-22) — the door's voice says what it is doing,
 *  from the instant a step opens until its first audio, on the SANDBOX
 *  (playwright.tree-first.config.ts). The pack is slowed on purpose (a phone's
 *  first uncached load): the step opens with the voice already `loading` (a
 *  signal glides the panel's rail, a pulse climbs the trunk, past 0.7 s the
 *  words say so), `speaking` comes with the element's own first audio, never
 *  before, and nothing goes idle in between. A line already in memory never
 *  shows the wait (the ~100 ms budget). The tree film: its lines come from
 *  the door's memory (the sandboxed frame fetches nothing), each beat's
 *  drawing starts WITH its voice, and the frame's first paint covers a wait
 *  that the door shows under it. */
import script from '../lib/onboard-script.json';

const SHOTS = process.env.TF_SHOTS || '../artifacts';
const line = (id: string) => script.lines.find((l) => l.id === id)?.en ?? `(no line ${id})`;
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/voice-wait-${name}.png` });

type Mark = { k: string; v: string; t: number };
/** every frame: what the screen says (step, voice, the wait's words + opacity), stamped */
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
      const door = document.querySelector('[data-testid="door"]');
      put('step', door?.getAttribute('data-step') ?? 'none');
      put('voice', document.querySelector('[data-testid="door-voice"]')?.getAttribute('data-voice') ?? 'none');
      const note = document.querySelector('[data-testid="door-voice-note"]');
      const op = note ? Number(getComputedStyle(note).opacity) : 0;
      put('note', note?.textContent && op > 0.05 ? note.textContent : '');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const marks = (page: Page) => page.evaluate(() => (window as unknown as { __m: Mark[] }).__m);
const first = (m: Mark[], k: string, v: string, after = 0) => m.find((x) => x.k === k && x.v === v && x.t >= after);

test.use({ hasTouch: true, isMobile: true });

test('no dead air: a slow voice is on its way from the step’s first frame to its first audio', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const DELAY = 1_800;
  // the first uncached load on a slow phone network: every line of the pack is late
  await page.route('**/onboarding/en/*.mp3', async (r) => {
    await new Promise((res) => setTimeout(res, DELAY));
    await r.continue();
  });
  await filmstrip(page);
  await page.goto('/');
  const tree = page.getByTestId('tree-first');
  await expect(tree).toBeVisible();
  await tree.tap(); // the greeting was asked for at first paint — still on the wire

  // the step opens with the voice already loading; the words say so past 0.7 s
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'lang');
  await expect(page.getByTestId('door')).toHaveAttribute('data-voice', 'loading');
  await expect(page.getByTestId('door-say')).toContainText('this is bifrost');
  await expect
    .poll(async () => (await marks(page)).find((x) => x.k === 'note' && x.v)?.v ?? '', { timeout: 5_000 })
    .toBe('the voice is on its way…');
  await shot(page, '1-door-loading');
  await expect(page.getByTestId('door-voice')).toHaveAttribute('data-voice', 'speaking', {
    timeout: DELAY + 5_000,
  });
  await expect(page.getByTestId('door-voice-note')).toHaveText('');
  await shot(page, '2-door-speaking');

  const m = await marks(page);
  const open = first(m, 'step', 'lang')!;
  const load = first(m, 'voice', 'loading')!;
  const speak = first(m, 'voice', 'speaking', open.t)!;
  console.log(
    `voice-wait door: step open → loading ${Math.round(load.t - open.t)}ms → first audio ${Math.round(speak.t - open.t)}ms`
  );
  // the same frame as the step (≤ 1 frame of slack), never idle before the audio
  expect(load.t - open.t).toBeLessThanOrEqual(20);
  expect(m.filter((x) => x.k === 'voice' && x.t > load.t && x.t < speak.t).map((x) => x.v)).toEqual([]);
  // honest: it really was waiting on the wire
  expect(speak.t - open.t).toBeGreaterThan(300);

  // the next line was fetched while this one loaded and spoke: in memory → no wait shown
  await page.waitForTimeout(DELAY + 400);
  const before = (await marks(page)).length;
  await page.getByTestId('door-lang-en').click();
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'style');
  await expect(page.getByTestId('door-voice')).toHaveAttribute('data-voice', 'speaking', { timeout: 3_000 });
  const m2 = (await marks(page)).slice(before);
  const open2 = first(m2, 'step', 'style')!;
  const speak2 = first(m2, 'voice', 'speaking', open2.t)!;
  console.log(`voice-wait door: cached line → first audio ${Math.round(speak2.t - open2.t)}ms`);
  expect(speak2.t - open2.t).toBeLessThanOrEqual(150);
  expect(m2.filter((x) => x.k === 'note' && x.v)).toEqual([]);
});

test('no dead air: the tree film plays from the door’s memory, each beat’s drawing starts with its voice', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const DELAY = 2_000;
  const reqs: { url: string; main: boolean }[] = [];
  page.on('request', (r) => {
    if (/\/onboarding\/en\/name_\w+\.mp3$/.test(r.url()))
      reqs.push({ url: r.url(), main: r.frame() === page.mainFrame() });
  });
  await page.route('**/onboarding/en/name_*.mp3', async (r) => {
    await new Promise((res) => setTimeout(res, DELAY));
    await r.continue();
  });
  await page.goto('/');
  await page.getByTestId('tree-first').tap();
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'lang');
  await page.getByTestId('door-names').getByRole('button', { name: 'why these names?' }).click();
  await page.getByTestId('door-film').click(); // at once: the names' lines are still on the wire

  const frame = page.getByTestId('door-film-frame');
  await expect(frame).toBeVisible();
  // the frame's first paint takes over from the door's wait
  await expect(frame).toHaveAttribute('data-up', '', { timeout: 10_000 });
  await expect(page.getByTestId('door-film-wait')).toBeHidden();
  const f = page.frameLocator('[data-testid="door-film-frame"] iframe');
  const body = f.locator('body');
  const svg = f.locator('svg');
  // beat one is asked for: the line is on screen, dim; the drawing waits for its voice
  await expect(body).toHaveAttribute('data-voice', 'loading');
  await expect(f.locator('#say')).toHaveText(line('name_tree'));
  await expect(svg).not.toHaveClass(/b-tree/);
  await expect(f.locator('#sub')).toHaveText('the voice is on its way…');
  await shot(page, '3-film-loading');
  const play = f.locator('#play');
  // the browser may want one tap inside the film before it speaks
  await expect
    .poll(async () => ((await play.isVisible()) ? 'play' : await body.getAttribute('data-voice')), {
      timeout: DELAY + 8_000,
    })
    .toMatch(/speaking|play/);
  if (await play.isVisible()) await play.click();
  await expect(body).toHaveAttribute('data-voice', 'speaking', { timeout: 10_000 });
  await expect(svg).toHaveClass(/b-tree/);
  await expect(f.locator('#sub')).toHaveText('');
  await shot(page, '4-film-speaking');
  // the next beats were in memory before they were needed: no wait between them
  await expect(svg).toHaveClass(/b-root/, { timeout: 15_000 });
  // the film fetched nothing itself: every line came from the door's memory, once
  const names = reqs.map((r) => r.url.split('/').pop());
  expect(reqs.filter((r) => !r.main)).toEqual([]);
  expect(new Set(names).size).toBe(names.length);
  for (const id of ['name_tree', 'name_root', 'name_trunk', 'name_branch', 'name_try', 'name_done'])
    expect(names).toContain(`${id}.mp3`);
});

/** the far vision (FILM-V1) is built in, like the tree film: served by the
 *  artifact route, its spoken lines = the script's, word for word, both
 *  languages, each one in the pack (veraldar.org gets the same files) */
test('the far vision: built in, its lines are the script’s, every one voiced', async ({ request }) => {
  const r = await request.get('/api/artifact/far-vision.html');
  expect(r.status()).toBe(200);
  const html = await r.text();
  const fv = script.lines.filter((l) => l.id.startsWith('fv_'));
  expect(fv.length).toBeGreaterThanOrEqual(25);
  for (const l of fv) {
    expect(html, `film line ${l.id}`).toContain(l.en);
    expect(html, `film line ${l.id} (fr)`).toContain(l.fr);
    for (const lang of ['en', 'fr'])
      expect((await request.head(`/onboarding/${lang}/${l.id}.mp3`)).status(), `${lang}/${l.id}.mp3`).toBe(200);
  }
});

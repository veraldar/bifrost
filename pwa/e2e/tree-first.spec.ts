import { type Page, expect, test } from '@playwright/test';
/** THE DOOR (v2 → v3 10-22), end to end on the SANDBOX (:8090, own config —
 *  playwright.tree-first.config.ts): fresh device → the tree in the server
 *  HTML → press = amber in the same frame → release = the greeting from the
 *  pre-recorded pack → language · style (MAIN seeded with them) · the brain
 *  the computer runs, shown with its provider → MAIN with the first-turn card
 *  → home: list + the roots (MAIN, MAINFRAME-C 10-26). v3: every name glossed where it
 *  first appears; back/forward walk the steps and keep the #door= answers;
 *  "why these names?" → the $ tree, spoken → the tree film (a built-in
 *  artifact) played through its try-it. The voice turn itself is
 *  first-turn-voice.spec.ts. */
import script from '../lib/onboard-script.json';

const SHOTS = process.env.TF_SHOTS || '../artifacts';
const line = (id: string, lang: 'en' | 'fr' = 'en') =>
  script.lines.find((l) => l.id === id)?.[lang] ?? `(no line ${id})`;
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/door-${name}.png` });

/** diag events persist in localStorage (lib/diag.ts ring) */
async function diag(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (JSON.parse(localStorage.getItem('oz-diag') || '[]') as { kind: string; msg: string }[]).map(
      (e) => `${e.kind} ${e.msg}`
    )
  );
}
async function firstAudioMs(page: Page, id: string, lang = 'en'): Promise<number> {
  const re = new RegExp(`prerender ${id} ${lang} first audio (\\d+)ms`);
  let ms = -1;
  await expect
    .poll(
      async () => {
        const hit = (await diag(page)).map((l) => re.exec(l)).find(Boolean);
        ms = hit ? Number(hit[1]) : -1;
        return ms;
      },
      { timeout: 10_000, message: `no first audio for ${id}` }
    )
    .toBeGreaterThanOrEqual(0);
  return ms;
}

test('door: first paint → hold → greeting → language · style · brain → MAIN', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);

  // 0 · the tree is in the server HTML: it paints before any script runs
  const html = await (await request.get('/')).text();
  expect(html).toContain('data-testid="tree-first"');
  expect(html).toContain('hold the tree to begin');
  expect(html).toContain('the tree stands for your own computer'); // the first name, glossed
  expect(html).toContain("localStorage.removeItem('labmic')"); // the boot script heals stuck phones

  // 1 · a fresh device: the tree alone — no list, no chrome
  const mp3s: { url: string; at: number }[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/onboarding/')) mp3s.push({ url: r.url(), at: Date.now() });
  });
  await page.goto('/');
  // the user's phone after the 10-14 run: a stuck lab-mic flag, and v1's
  // abandoned setup left hands-free armed — the door must undo both
  await page.evaluate(() => {
    localStorage.setItem('labmic', '1');
    localStorage.setItem('oz-mode', 'free');
    localStorage.setItem('tree-first-prev-mode', 'text');
  });
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem('labmic'))).toBeNull();
  const tree = page.getByTestId('tree-first');
  await expect(tree).toBeVisible();
  await expect(page.locator('header')).toHaveCount(0);
  await expect(page.getByTestId('tree-door')).toHaveCount(0);
  await expect(page.getByText('hold the tree to begin')).toBeVisible();
  await shot(page, '1-first-open');

  // 2 · press → amber in the same frame (no React round-trip)
  const b = (await tree.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  expect(await tree.evaluate((el) => el.classList.contains('heard'))).toBe(true);
  await expect(page.getByText('heard', { exact: true })).toBeVisible();
  await shot(page, '2-held');
  // the greeting was fetched into memory before the finger landed
  expect(mp3s.some((m) => m.url.endsWith('/onboarding/en/greet.mp3'))).toBe(true);

  // 3 · release → the door speaks: greeting from the pack, ≤ 1 s to first audio
  await page.mouse.up();
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'lang');
  await expect(page.getByTestId('door-say')).toContainText('this is bifrost');
  await expect(page.getByTestId('door-gloss')).toContainText(
    'bifrost — the bridge between you and your computer'
  );
  expect(page.url()).toMatch(/#at=lang$/); // a history entry per step
  const greetMs = await firstAudioMs(page, 'greet');
  console.log(`door: greet first audio ${greetMs}ms`);
  expect(greetMs).toBeLessThanOrEqual(1_000);
  await shot(page, '3-greeting');

  // 4 · language → style; the pick is confirmed in the same voice
  await page.getByTestId('door-lang-en').click();
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'style');
  await expect(page.getByTestId('door-say')).toContainText(/english|short answers/);
  const confirmMs = await firstAudioMs(page, 'lang_set');
  console.log(`door: answer → spoken confirmation ${confirmMs}ms`);
  expect(confirmMs).toBeLessThanOrEqual(1_000);
  await shot(page, '4-style');

  // 5 · style → MAIN is seeded with both answers, the brain is SHOWN
  const seeded = page.waitForResponse(
    (r) => r.url().endsWith('/api/onboard') && r.request().method() === 'POST'
  );
  await page.getByTestId('door-style-short').click();
  const res = await seeded;
  expect(res.status()).toBe(200);
  expect(JSON.parse(res.request().postData() || '{}')).toEqual({
    step: 'main',
    prefs: { lang: 'en', style: 'short' },
  });
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'brain');
  const box = (await (await request.get('/api/onboard')).json()) as {
    brain: { model: string; class: string; provider: string };
  };
  // this computer thinks through z.ai's coding plan (yggdrasil.env) — named, generically
  expect(box.brain).toMatchObject({ class: 'cloud', provider: 'z.ai' });
  await expect(page.getByTestId('door-brain')).toContainText(box.brain.model);
  await expect(page.getByTestId('door-brain')).toContainText(`at ${box.brain.provider}`);
  await expect(page.getByTestId('door-brain')).toContainText('set on your computer');
  await expect(page.getByTestId('door-gloss')).toContainText('the root — your tree’s brain');
  expect(page.url()).toMatch(/#door=v1\.en\.short&at=brain$/);
  await expect(page.getByTestId('door-say')).toContainText('the brain is a cloud service', {
    timeout: 15_000,
  });
  // desktop (fine pointer, no touch): the QR hands the door to the phone
  await expect(page.getByTestId('door-qr').locator('img')).toBeVisible();
  await expect(page.getByTestId('door-enter')).toHaveText('continue here');
  await shot(page, '5-brain-qr');

  // 6 · enter → MAIN, planted, the first-turn card — no voice turn here
  await page.getByTestId('door-enter').click();
  await page.waitForURL(/\/session\/main\?id=.+&first=1/, { timeout: 20_000 });
  const card = page.getByTestId('first-turn');
  await expect(card).toBeVisible();
  if ((await card.getAttribute('data-state')) === 'mic') {
    await page.getByTestId('first-allow-mic').click();
  }
  await expect(card).toHaveAttribute('data-state', 'practice');
  await expect(card).toContainText('ready. this is main — your main conversation.');
  await expect(card).toContainText('hold the mic');
  const ls = await page.evaluate(() => ({
    door: localStorage.getItem('bifrost-door'),
    prefs: localStorage.getItem('bifrost-onboard'),
    first: localStorage.getItem('bifrost-first-turn'),
    labmic: localStorage.getItem('labmic'),
    mode: localStorage.getItem('oz-mode'),
    prev: localStorage.getItem('tree-first-prev-mode'),
    shrink: sessionStorage.getItem('tree-first-shrink'),
  }));
  expect(ls).toEqual({
    door: 'v2',
    prefs: JSON.stringify({ lang: 'en', style: 'short' }),
    first: null,
    labmic: null,
    mode: 'text', // the door pins text mode: the first turn is hold-to-talk
    prev: null,
    shrink: '1',
  });
  await expect(page.getByTestId('composer-mic')).toBeVisible();
  // a TAP is not a turn (and never flips hands-free during the first turn)
  const mic = page.getByTestId('composer-mic');
  await mic.click({ delay: 60 });
  await expect(card).toContainText('released — nothing sent');
  await expect(page.getByTestId('free-strip')).toHaveCount(0);
  const lines = await diag(page);
  expect(lines.some((l) => /prerender miss/.test(l))).toBe(false);
  await shot(page, '6-main-first-turn');

  // 7 · home afterwards: the list + the roots at the bottom — they ARE MAIN
  // (MAINFRAME-C 10-26: the corner door is gone, MAIN is not a row); they
  // grow up from the bottom edge once, after the door
  await page.goto('/');
  const roots = page.getByTestId('roots');
  await expect(roots).toBeVisible();
  await expect(page.getByTestId('tree-door')).toHaveCount(0);
  await expect(page.getByTestId('tree-first')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'BIFROST' })).toBeVisible();
  await expect(roots).not.toHaveClass(/grow/, { timeout: 5_000 });
  await expect(page.getByTestId('roots-hit')).toHaveAttribute('href', '/session/main');
  await expect(page.locator('.oz-sw', { hasText: '[MAIN]' })).toHaveCount(0);
  expect((await request.delete('/api/session/main')).status()).toBe(403);
  await shot(page, '7-roots');

  // 8 · a returning device never sees the door again (hidden before paint)
  await page.reload();
  await expect(page.getByTestId('tree-first')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.door)).toBe('done');
});

test.describe('phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('door: answers carried from veraldar.org skip their steps, no QR on a phone', async ({
    page,
  }) => {
    // the seed POST is answered here: the real one ran in the test above, and
    // a second set of answers would rewrite MAIN's standing preferences
    let posted: unknown = null;
    await page.route('**/api/onboard', (r) => {
      if (r.request().method() !== 'POST') return r.continue();
      posted = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ json: { id: 'ses_e2e', title: '[MAIN]', slug: 'main', created: false } });
    });
    await page.goto('/#door=v1.fr.detail');
    const tree = page.getByTestId('tree-first');
    await expect(tree).toBeVisible();
    await tree.tap();
    // straight to the brain step, in French, with the site's answers
    await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'brain');
    await expect(page.getByTestId('door-say')).toContainText(line('greet_back', 'fr'));
    await expect
      .poll(() => posted)
      .toEqual({ step: 'main', prefs: { lang: 'fr', style: 'detail' } });
    await expect(page.getByTestId('door-brain')).toContainText('plus de détail');
    await expect(page.getByTestId('door-qr')).toHaveCount(0);
    await expect(page.getByTestId('door-enter')).toHaveText('continuer');
    await shot(page, 'p1-carried-fr');
  });

  test('door: back/forward walk the steps, keep the #door= answers, then leave to the page before', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.route('**/api/onboard', (r) =>
      r.request().method() !== 'POST'
        ? r.continue()
        : r.fulfill({ json: { id: 'ses_e2e', title: '[MAIN]', slug: 'main', created: false } })
    );
    const step = () => page.getByTestId('door').getAttribute('data-step');
    // the page that sent you (veraldar.org in life): any page before the door
    await page.goto('/api/artifact/door-tree.html');
    const before = page.url();

    // 1 · a fresh walk: tree → lang → style, one history entry each
    await page.goto('/');
    await page.getByTestId('tree-first').tap();
    await expect.poll(step).toBe('lang');
    await page.getByTestId('door-lang-en').click();
    await expect.poll(step).toBe('style');
    expect(page.url()).toMatch(/#door=v1\.en&at=style$/);
    await page.goBack(); // → the language step, asked again
    await expect.poll(step).toBe('lang');
    await expect(page.getByTestId('door-say')).toHaveText(line('lang'));
    await page.goForward(); // → style, the answer still there
    await expect.poll(step).toBe('style');
    await page.goBack();
    await page.goBack(); // → the tree itself
    await expect.poll(step).toBe('idle');
    await expect(page.getByText('hold the tree to begin')).toBeVisible();
    await page.goBack(); // → the page before: never a dead end
    await expect.poll(() => page.url()).toBe(before);

    // 2 · the site's handoff survives a back-forward cycle
    await page.goto('/#door=v1.fr.detail');
    await page.getByTestId('tree-first').tap();
    await expect.poll(step).toBe('brain');
    await expect(page.getByTestId('door-brain')).toContainText('plus de détail');
    await page.goBack();
    await expect.poll(step).toBe('idle');
    expect(page.url()).toMatch(/#door=v1\.fr\.detail$/);
    await page.goForward();
    await expect.poll(step).toBe('brain');
    await expect(page.getByTestId('door-brain')).toContainText('plus de détail');
    await expect(page.getByTestId('door-enter')).toBeEnabled();
    // a reload mid-door is the tree again, with the answers
    await page.reload();
    await expect.poll(step).toBe('idle');
    expect(page.url()).toMatch(/#door=v1\.fr\.detail$/);
    await page.getByTestId('tree-first').tap();
    await expect.poll(step).toBe('brain');
    await shot(page, 'p2-history');
  });

  test('door: why these names? → the $ tree, spoken → the tree film, its try-it, back to the door', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    // the film is the script's own lines, word for word, both languages
    const film = await (await request.get('/api/artifact/door-tree.html')).text();
    for (const l of script.lines.filter((x) => x.id.startsWith('name_'))) {
      expect(film, `film line ${l.id}`).toContain(l.en);
      expect(film, `film line ${l.id} (fr)`).toContain(l.fr);
    }
    await page.goto('/');
    await page.getByTestId('tree-first').tap();
    await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'lang');
    // simple first: the names wait behind one line
    const names = page.getByTestId('door-names');
    await expect(names.locator('.tree')).toHaveCount(0);
    await names.getByRole('button', { name: 'why these names?' }).click();
    for (const n of ['yggdrasil', 'root', 'trunk', 'branch', 'bifrost']) {
      await expect(names.locator('.tree')).toContainText(n);
    }
    await page.getByTestId('door-names-hear').click();
    await expect(page.getByTestId('door-say')).toHaveText(line('name_tree'));
    await firstAudioMs(page, 'name_tree');
    await shot(page, 'p3-names');

    // the film: lazy (no request for it before the tap), its own history entry
    await page.getByTestId('door-film').click();
    await expect(page.getByTestId('door-film-frame')).toBeVisible();
    expect(page.url()).toMatch(/&film$/);
    const f = page.frameLocator('[data-testid="door-film-frame"] iframe');
    const play = f.locator('#play');
    // the browser may want one tap inside the film before it speaks
    if (await play.isVisible({ timeout: 1_500 }).catch(() => false)) await play.click();
    await expect(f.locator('#say')).toHaveText(line('name_tree'), { timeout: 10_000 });
    await expect(f.locator('svg')).toHaveClass(/b-root/, { timeout: 15_000 });
    await shot(page, 'p4-film');
    // back closes the film, the door stays where it was
    await page.goBack();
    await expect(page.getByTestId('door-film-frame')).toHaveCount(0);
    await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'lang');

    // again, to the end: five beats → the try-it
    await page.getByTestId('door-film').click();
    if (await play.isVisible({ timeout: 1_500 }).catch(() => false)) await play.click();
    await expect(f.locator('#sub')).toHaveText('press and hold anywhere on the tree', {
      timeout: 40_000,
    });
    const svg = f.locator('svg');
    // a tap is not a message (the mic's own rule)
    await svg.dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true });
    await svg.dispatchEvent('pointerup', { pointerId: 1, isPrimary: true });
    await expect(f.locator('#sub')).toContainText('a tap is not a message');
    // hold = heard (amber), let go = the trip down to the root and back
    await svg.dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true });
    await expect(svg).toHaveClass(/heard/);
    await expect(f.locator('#sub')).toHaveText('heard · let go to send');
    await page.waitForTimeout(600);
    await svg.dispatchEvent('pointerup', { pointerId: 1, isPrimary: true });
    await expect(f.locator('#sub')).toContainText('your words go down the trunk');
    await expect(svg).toHaveClass(/answered/, { timeout: 10_000 });
    await expect(f.locator('#say')).toHaveText(line('name_done'));
    await shot(page, 'p5-film-answered');
    await f.locator('#done').click({ timeout: 15_000 });
    await expect(page.getByTestId('door-film-frame')).toHaveCount(0);
    expect(page.url()).not.toMatch(/film/);
    await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'lang');
  });
});

import { type Page, expect, test } from '@playwright/test';
import presets from '../lib/brain-presets.json';

/** veraldar.org's door (v3, 10-22) — playwright.site.config.ts serves the
 *  site's working copy. Layman copy (no "box"), every step a history entry
 *  (#door-step=N: back walks the steps, then out; back from the app lands on
 *  the last step), the brain = ANY provider (presets from the app's own
 *  brain-presets.json, the settings block written to match), the $ tree with
 *  its spoken version + the tree film, /start no longer a 404. */

const SHOTS = process.env.TF_SHOTS || '../artifacts';

async function openDoor(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const tree = page.locator('#tree');
  await tree.scrollIntoViewIfNeeded();
  await tree.dispatchEvent('pointerdown');
  await tree.dispatchEvent('pointerup');
  await expect(page.locator('#door')).toBeVisible();
}
const say = (page: Page) => page.locator('#dsay');
const doorText = (page: Page) => page.locator('#door .door').innerText();

test('site door: plain words, the names glossed, back walks the steps and out', async ({
  page,
}) => {
  await openDoor(page);
  await expect(page).toHaveURL(/#door-step=0$/);
  await expect(say(page)).toContainText('talk to your own computer from your phone');
  await expect(page.locator('#dgloss')).toHaveText(
    'bifrost — the bridge between you and your computer'
  );
  expect(await doorText(page)).not.toMatch(/\bbox\b|tailnet|systemd/i);
  // simple first: the $ tree waits behind one line
  const why = page.getByTestId('door-why');
  await why.click();
  for (const n of ['yggdrasil', 'root', 'trunk', 'branch', 'bifrost']) {
    await expect(page.locator('#door .nt')).toContainText(n);
  }
  await page.screenshot({ path: `${SHOTS}/site-door-0-names.png` });

  await page.locator('#dnext').click(); // → language
  await expect(page).toHaveURL(/#door-step=1$/);
  await page.locator('#dnext').click(); // → style
  await expect(page).toHaveURL(/#door-step=2$/);
  await expect(say(page)).toHaveText('short answers, or more detail?');
  await page.goBack(); // → language, still in the door
  await expect(page).toHaveURL(/#door-step=1$/);
  await expect(say(page)).toHaveText('english or french?');
  await expect(page.locator('#door')).toBeVisible();
  await page.goBack();
  await page.goBack(); // → out of the door, the page as it was
  await expect(page.locator('#door')).toBeHidden();
  expect(new URL(page.url()).hash).toBe('');
  await page.goForward(); // forward → the door again, at its step
  await expect(page.locator('#door')).toBeVisible();
  await expect(page).toHaveURL(/#door-step=0$/);
});

test('site door: any provider — presets fill the settings, other takes any address, local needs no key', async ({
  page,
}) => {
  await openDoor(page);
  for (let i = 0; i < 3; i++) await page.locator('#dnext').click(); // → the brain
  await expect(say(page)).toContainText('who does the thinking?');
  await expect(page.locator('#dgloss')).toContainText('the root — your tree’s brain');
  const chips = page.locator('#door .chip[data-prov]');
  await expect(chips).toHaveText(['z.ai', 'openrouter', 'anthropic', 'openai', 'other']);
  // z.ai is a preset, not the only path: every preset fills from the app's file
  for (const p of presets.presets.filter((x) => !('local' in x) && x.id !== 'other')) {
    await page.locator(`#door .chip[data-prov="${p.id}"]`).click();
    await expect(page.getByTestId('door-base')).toHaveValue(p.base);
    await expect(page.getByTestId('door-model')).toHaveValue(p.model);
    await expect(page.getByTestId('door-key-link')).toHaveAttribute('href', p.keys);
  }
  await page.locator('#door .chip[data-prov="anthropic"]').click();
  await page.screenshot({ path: `${SHOTS}/site-door-3-brain.png` });
  await page.locator('#dnext').click(); // → the end: settings written for anthropic
  const env = page.getByTestId('door-env');
  await expect(env).toContainText('YGG_UPSTREAM_BASE_URL=https://api.anthropic.com');
  await expect(env).toContainText('YGG_UPSTREAM_STYLE=anthropic');
  await expect(env).toContainText('YGG_UPSTREAM_MODEL=claude-sonnet-5-5');
  await expect(env).toContainText('YGG_UPSTREAM_API_KEY=PASTE_YOUR_KEY_HERE');
  expect(await doorText(page)).not.toMatch(/\bbox\b/i);
  await page.screenshot({ path: `${SHOTS}/site-door-4-end.png`, fullPage: true });

  // other: any address, any format
  await page.goBack();
  await page.locator('#door .chip[data-prov="other"]').click();
  await expect(page.getByTestId('door-base')).toHaveValue('');
  await page.getByTestId('door-base').fill('https://llm.example.org/v1');
  await page.getByTestId('door-model').fill('my-model-7b');
  await page.locator('#door .chip[data-fmt="openai"]').click();
  await page.locator('#dnext').click();
  await expect(env).toContainText('YGG_UPSTREAM_BASE_URL=https://llm.example.org/v1');
  await expect(env).toContainText('YGG_UPSTREAM_STYLE=openai');
  await expect(env).toContainText('YGG_UPSTREAM_MODEL=my-model-7b');

  // local: a server at home, no key
  await page.goBack();
  await page.locator('#dopts .opt').nth(1).click(); // your own computer
  await expect(page.locator('#door .chip[data-prov]')).toHaveCount(0);
  await expect(page.getByTestId('door-base')).toHaveValue('http://127.0.0.1:11434/v1');
  await page.locator('#dnext').click();
  await expect(env).toContainText('YGG_UPSTREAM_API_KEY=');
  await expect(env).not.toContainText('PASTE_YOUR_KEY_HERE');
  await expect(env).toContainText('nothing leaves your home');
});

test('site door: the handoff link carries the answers; back from the app lands on the last step', async ({
  page,
}) => {
  await openDoor(page);
  await page.locator('#dskip').click(); // → the last step
  await expect(page).toHaveURL(/#door-step=4$/);
  // skipped past the brain: the settings still carry the default service's own values
  const env = page.getByTestId('door-env');
  await expect(env).toContainText('YGG_UPSTREAM_BASE_URL=https://api.z.ai/api/anthropic');
  await expect(env).toContainText('YGG_UPSTREAM_STYLE=anthropic');
  await expect(env).toContainText('YGG_UPSTREAM_MODEL=glm-5.3-flash');
  await page.locator('#dbox').fill('mycomputer.tail1234.ts.net:8443');
  await expect(page.getByTestId('door-open')).toHaveAttribute(
    'href',
    'https://mycomputer.tail1234.ts.net:8443/#door=v1.en.short'
  );
  // leave the site the way the link does (a full navigation), then come back
  await page.goto('/start.html');
  await page.goBack();
  await expect(page.locator('#door')).toBeVisible();
  await expect(page).toHaveURL(/#door-step=4$/);
  await expect(page.locator('#dbox')).toHaveValue('mycomputer.tail1234.ts.net:8443');
  await expect(page.getByTestId('door-open')).toBeVisible();
  // the QR's address is a page now, not a 404
  const start = await page.request.get('/start/');
  expect(start.status()).toBe(200);
  expect(await start.text()).toContain('/start.html');
});

test('site: the tree, spoken and filmed — the film is the app’s own, back closes it', async ({
  page,
  request,
}) => {
  const film = await request.get('/onboarding/tree.html');
  expect(film.status()).toBe(200);
  expect(await film.text()).toContain('THE TREE FILM');
  await page.goto('/');
  await page.locator('#lore pre').scrollIntoViewIfNeeded();
  await expect(page.locator('#lore pre')).toContainText('the brain: thinks, remembers');
  await page.locator('#lore-film').click();
  await expect(page.locator('#film')).toBeVisible();
  await expect(page.locator('#film iframe')).toHaveAttribute(
    'src',
    /onboarding\/tree\.html\?lang=en/
  );
  const f = page.frameLocator('#film iframe');
  await expect(f.locator('#hd')).toHaveText('YOUR TREE · 15 S');
  await page.goBack();
  await expect(page.locator('#film')).toBeHidden();
  await expect(page.locator('#film iframe')).toHaveAttribute('src', 'about:blank');
});

/** NO DEAD AIR (FILM-V1, 10-22) — the pack slowed on purpose (a phone's first
 *  uncached load): the door opens with its voice already loading (the panel's
 *  edge glides, past 0.7 s the words say so), speaking only with the first
 *  audio; the film's frame waits under the same rail until its first paint,
 *  then plays from the site's memory (the sandboxed frame fetches nothing),
 *  each beat's drawing starting with its voice. Real taps: audio may play. */
test('site: no dead air — the door and the film say the voice is on its way until it plays', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const DELAY = 3_000; // the words show from 0.7 s (fully by 1 s): a window the polls can't miss
  const frameReqs: string[] = [];
  page.on('request', (r) => {
    if (/\/onboarding\/en\/\w+\.mp3$/.test(r.url()) && r.frame() !== page.mainFrame()) frameReqs.push(r.url());
  });
  await page.route('**/onboarding/en/*.mp3', async (r) => {
    await new Promise((res) => setTimeout(res, DELAY));
    await r.continue();
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const tree = page.locator('#tree');
  await tree.scrollIntoViewIfNeeded();
  await tree.tap(); // the greeting is still on the wire
  await expect(page.locator('#door')).toBeVisible();
  const rail = page.getByTestId('door-voice');
  await expect(rail).toHaveAttribute('data-voice', 'loading');
  await expect(rail).toHaveAttribute('data-s', 'working');
  await expect(page.getByTestId('door-voice-note')).toHaveText('the voice is on its way…');
  await expect
    .poll(() => page.getByTestId('door-voice-note').evaluate((e) => Number(getComputedStyle(e).opacity)), {
      intervals: [100],
      timeout: DELAY,
    })
    .toBeGreaterThan(0.9);
  await page.screenshot({ path: `${SHOTS}/site-voice-1-loading.png` });
  await expect(rail).toHaveAttribute('data-voice', 'speaking', { timeout: DELAY + 5_000 });
  await expect(rail).toHaveAttribute('data-s', 'speaking');
  await expect(page.getByTestId('door-voice-note')).toHaveText('');
  await page.screenshot({ path: `${SHOTS}/site-voice-2-speaking.png` });

  // the film, at once: its lines are still on the wire
  await page.getByTestId('door-why').click();
  await page.locator('#door [data-k=film]').click();
  await expect(page.locator('#film')).toBeVisible();
  await expect(page.locator('#film')).toHaveAttribute('data-up', '', { timeout: 10_000 });
  await expect(page.locator('#film-wait')).toBeHidden();
  const f = page.frameLocator('#film iframe');
  await expect(f.locator('body')).toHaveAttribute('data-voice', 'loading');
  await expect(f.locator('svg')).not.toHaveClass(/b-tree/);
  await expect(f.locator('#sub')).toHaveText('the voice is on its way…');
  await page.screenshot({ path: `${SHOTS}/site-voice-3-film-loading.png` });
  const play = f.locator('#play');
  await expect
    .poll(async () => ((await play.isVisible()) ? 'play' : await f.locator('body').getAttribute('data-voice')), {
      timeout: DELAY + 8_000,
    })
    .toMatch(/speaking|play/);
  if (await play.isVisible()) await play.click();
  await expect(f.locator('body')).toHaveAttribute('data-voice', 'speaking', { timeout: 10_000 });
  await expect(f.locator('svg')).toHaveClass(/b-tree/);
  expect(frameReqs).toEqual([]);
});

/** both surfaces, for real: APP_URL=https://<computer>:8443 (the sandbox) —
 *  the site's handoff opens the app's door with the answers, and the phone's
 *  back button walks the app's steps, then lands on the site's last step */
test('site → app → back: the #door= handoff, then back to the site’s last step', async ({
  page,
}) => {
  test.skip(!process.env.APP_URL, 'APP_URL not set');
  const app = new URL(process.env.APP_URL!);
  // the app's seed POST is answered here: MAIN's real preferences stay as they are
  await page.route(`${app.origin}/api/onboard`, (r) =>
    r.request().method() !== 'POST'
      ? r.continue()
      : r.fulfill({ json: { id: 'ses_e2e', title: '[MAIN]', slug: 'main', created: false } })
  );
  await openDoor(page);
  await page.locator('#dnext').click(); // → language
  await page.locator('#dopts .opt').nth(1).click(); // français
  await page.locator('#dskip').click(); // → the last step
  await page.locator('#dbox').fill(app.host);
  const open = page.getByTestId('door-open');
  await expect(open).toHaveAttribute('href', `${app.origin}/#door=v1.fr.short`);
  await open.click();
  await page.waitForURL(`${app.origin}/#door=v1.fr.short`);
  const tree = page.getByTestId('tree-first');
  await tree.tap();
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'brain');
  await expect(page.getByTestId('door-say')).toContainText('vos réponses ont suivi');
  await page.goBack(); // the app's tree, answers kept
  await expect(page.getByTestId('door')).toHaveAttribute('data-step', 'idle');
  await page.goBack(); // → the site, its last step, the address still there
  await expect(page).toHaveURL(/#door-step=4$/);
  await expect(page.locator('#door')).toBeVisible();
  await expect(page.locator('#dbox')).toHaveValue(app.host);
  await page.screenshot({ path: `${SHOTS}/site-door-5-back-from-app.png` });
});

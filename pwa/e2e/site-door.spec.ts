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

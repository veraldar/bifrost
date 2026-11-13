import { OC } from './brain';
import { type APIRequestContext, type Locator, type Page, expect, test } from '@playwright/test';

/** ROOT-COORD (11-12): the home list is the brain's real tree — sessions nest
 *  to any depth under their parent, each row speaks its card (status dot/word,
 *  "asks: …" or the headline), hot branches open, calm ones fold, closed
 *  sessions wait behind "N closed"; MAIN's `→ <title>` route tags link to
 *  those sessions; a managed session's page shows its card line.
 *
 *  SIM ONLY — needs the fixture tree in the brain's data dir BEFORE the brain
 *  starts (cards can't be set through the API):
 *    node e2e/tree-seed.mjs $YGG_DATA_DIR   # then start the brain + the app
 *    PW_BASE_URL=http://127.0.0.1:<sim app> npx playwright test e2e/tree.spec.ts
 *  TREE_SHOTS=<dir> also writes the 412x915 light/dark screenshots there. */

test.use({ hasTouch: true });

const TAG = `e2e-tree-${Date.now().toString(36)}`;
const created: string[] = [];

/** The proxy caches the enriched list for 60s; a create/delete through it busts it. */
async function bustListCache(request: APIRequestContext) {
  const r = await request.post('/api/session', { data: { name: `${TAG}-bust` } });
  const s = (await r.json()) as { id?: string };
  if (s.id) await request.delete(`/api/session/${s.id}`);
}

/** the row (the swipe button) titled exactly `title` */
const row = (page: Page, title: string): Locator =>
  page.locator('.oz-row').filter({ has: page.locator('.t', { hasText: new RegExp(`^${title}$`) }) });

/** how many sub-tree levels (.oz-kids) hold this row */
const depthOf = (r: Locator) =>
  r.evaluate((el) => {
    let d = 0;
    for (let p = el.parentElement; p; p = p.parentElement) if (p.classList.contains('oz-kids')) d++;
    return d;
  });

test.beforeAll(async ({ request }) => {
  const rows = (await (await request.get(`${OC}/tree`)).json()) as { id: string }[];
  expect(
    rows.some((r) => r.id === 'ses_t2erecipephotos'),
    'fixture tree missing — run `node e2e/tree-seed.mjs <YGG_DATA_DIR>` before starting the sim brain'
  ).toBe(true);
});

test.afterAll(async ({ request }) => {
  for (const id of created) await request.delete(`${OC}/session/${id}`).catch(() => {});
});

test('home: the tree nests 3 deep under MAIN, cards speak, closed sessions wait', async ({
  page,
  request,
}) => {
  await bustListCache(request);
  await page.goto('/');

  // MAIN's sub-tree, 3 levels: hot branches (working/blocked below) open by default
  const site = row(page, 'Static recipe site');
  const pages = row(page, 'Recipe pages');
  const photos = row(page, 'Recipe photos');
  await expect(site).toBeVisible();
  await expect(pages).toBeVisible();
  await expect(photos).toBeVisible();
  expect(await depthOf(site)).toBe(0);
  expect(await depthOf(pages)).toBe(1);
  expect(await depthOf(photos)).toBe(2);
  // all three sit inside the top-level <li> of their branch
  const branch = page.locator('li').filter({ has: site });
  await expect(branch.locator('.oz-row')).toHaveCount(4); // site, pages, photos, search box

  // cards: status word, "asks: …" before the headline, the headline otherwise
  await expect(photos.locator('.oz-st')).toHaveText('needs you');
  await expect(photos.locator('.oz-r2')).toHaveText(
    'asks: Which photo licence is OK — CC-BY or only CC0?'
  );
  await expect(site.locator('.oz-r2')).toHaveText(
    'index + 3 recipe pages drafted; search box in progress'
  );
  await expect(site.getByLabel('working')).toBeVisible(); // the green breath, no word
  await expect(site.locator('.oz-st')).toHaveCount(0);
  await expect(row(page, 'Wordfreq CLI').locator('.oz-st')).toHaveText('failed');
  await expect(row(page, 'Habit tracker CLI').locator('.oz-st')).toHaveText('done');
  await expect(pages.locator('.oz-r2')).toHaveText('3 recipe pages + shared stylesheet written');

  // MAIN's subtree comes before the other top-level sessions
  const order = await page.locator('ul > li .oz-row .t').allTextContents();
  expect(order.indexOf('Static recipe site')).toBeLessThan(order.indexOf('garden plan'));

  // closed sessions: hidden behind "N closed", per parent
  await expect(row(page, 'Old layout draft')).toHaveCount(0);
  await expect(row(page, 'Notes API stdlib')).toHaveCount(0);
  await branch.getByRole('button', { name: '1 closed' }).tap();
  await expect(row(page, 'Old layout draft')).toBeVisible();
  await expect(row(page, 'Old layout draft').locator('.oz-st')).toHaveText('closed');
  expect(await depthOf(row(page, 'Old layout draft'))).toBe(1);
  const mainClosed = page.locator('ul > li > button.oz-closed').first();
  await expect(mainClosed).toHaveText('1 closed');
  await mainClosed.tap();
  await expect(row(page, 'Notes API stdlib')).toBeVisible();

  // a calm card-less branch folds under its pill
  await expect(row(page, 'seed list')).toHaveCount(0);
  await expect(
    row(page, 'garden plan').getByRole('button', { name: '1 sub-session', exact: true })
  ).toBeVisible();

  // folding is the user's call and it sticks (per id, on the device)
  await site.getByRole('button', { name: '2 sub-sessions', exact: true }).tap();
  await expect(photos).toHaveCount(0);
  await page.reload();
  await expect(site).toBeVisible();
  await expect(photos).toHaveCount(0);
  await site.getByRole('button', { name: '2 sub-sessions', exact: true }).tap();
  await expect(photos).toBeVisible();
});

test('home: API-made nesting (no cards) renders, swipe deletes the whole family', async ({
  page,
  request,
}) => {
  const mk = async (title: string, parentID?: string) => {
    const s = (await (
      await request.post(`${OC}/session`, { data: { title, ...(parentID ? { parentID } : {}) } })
    ).json()) as { id: string };
    created.push(s.id);
    return s.id;
  };
  const main = ((await (await request.get(`${OC}/tree`)).json()) as { id: string; title: string }[]).find(
    (r) => r.title === '[MAIN]'
  )!.id;
  const l1 = await mk(`${TAG}-l1`, main);
  const l2 = await mk(`${TAG}-l2`, l1);
  const l3 = await mk(`${TAG}-l3`, l2);

  await bustListCache(request);
  await page.goto('/');
  const r1 = row(page, `${TAG}-l1`);
  await expect(r1).toBeVisible(); // MAIN's child: top level
  await expect(r1.locator('.oz-st')).toHaveCount(0); // no card, no word
  await expect(row(page, `${TAG}-l2`)).toHaveCount(0); // calm: folded
  await r1.getByRole('button', { name: '1 sub-session', exact: true }).tap();
  await row(page, `${TAG}-l2`).getByRole('button', { name: '1 sub-session', exact: true }).tap();
  await expect(row(page, `${TAG}-l3`)).toBeVisible();
  expect(await depthOf(row(page, `${TAG}-l3`))).toBe(2);

  // swipe l1 left past the threshold: the family goes (yggdrasil has no cascade)
  await r1.evaluate((el) => el.scrollIntoView({ block: 'center' })); // clear of the roots bar
  const box = (await r1.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 10, y);
  await page.mouse.down();
  await page.mouse.move(box.x - 90, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByText(`deleted “${TAG}-l1” + 2 subs`)).toBeVisible();
  await expect(row(page, `${TAG}-l3`)).toHaveCount(0);
  await expect
    .poll(
      async () => {
        const ids = ((await (await request.get(`${OC}/session`)).json()) as { id: string }[]).map(
          (s) => s.id
        );
        return [l1, l2, l3].filter((id) => ids.includes(id)).length;
      },
      { timeout: 15_000 }
    )
    .toBe(0);
});

test('MAIN: a route tag links to its session; the child shows its card line', async ({ page }) => {
  await page.goto('/session/main?id=ses_t2emain');
  const link = page.locator('a[data-route]', { hasText: 'Static recipe site' });
  await expect(link).toHaveCount(1); // the one in `code` stays code
  await expect(link).toHaveAttribute('href', '/session/static-recipe-site?id=ses_t2erecipesite');
  await expect(page.locator('a[data-route]', { hasText: 'Habit tracker CLI' })).toBeVisible();
  await expect(page.locator('a[data-route]', { hasText: 'Recipe photos' })).toBeVisible();
  await expect(page.locator('a[data-route]')).toHaveCount(3);
  await expect(page.getByText('New build session for the notes')).toBeVisible(); // unmatched: text
  await expect(page.locator('[data-streamdown="inline-code"]', { hasText: '→ Static recipe site' })).toBeVisible();
  await expect(page.getByTestId('session-card')).toHaveCount(0); // MAIN: nothing new

  await link.tap();
  await expect(page).toHaveURL(/\/session\/static-recipe-site\?id=ses_t2erecipesite$/);
  const card = page.getByTestId('session-card');
  await expect(card).toContainText('lead · glm-5.3-flash · working');
  await expect(card).toHaveAttribute('aria-expanded', 'false');
  await card.tap();
  await expect(card).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toContainText('a last pass over the shared stylesheet and a link check');
});

test('child page: a blocked card asks its question under the header', async ({ page }) => {
  await page.goto('/session/recipe-photos?id=ses_t2erecipephotos');
  const card = page.getByTestId('session-card');
  await expect(card).toContainText('research · glm-5.3-flash · blocked');
  await expect(card).toContainText('asks: Which photo licence is OK — CC-BY or only CC0?');
});

test('unit: route tags link known titles only, never inside code', async () => {
  const { linkRouteTags } = await import('../lib/route-tags');
  const t = [
    { id: 'ses_a', title: 'Unit converter CLI' },
    { id: 'ses_b', title: 'Todo count script' },
    { id: 'ses_c', title: 'Todo' },
  ];
  expect(
    linkRouteTags('Both are off: → Unit converter CLI (folder `units`) and → todo count script, ok', t)
  ).toBe(
    'Both are off: → [Unit converter CLI](/session/unit-converter-cli?id=ses_a) (folder `units`) and → [todo count script](/session/todo-count-script?id=ses_b), ok'
  );
  expect(linkRouteTags('→ Todo list: x', t)).toBe('→ [Todo](/session/todo?id=ses_c) list: x');
  expect(linkRouteTags('→ Todos are next', t)).toBe('→ Todos are next'); // no partial word
  expect(linkRouteTags('`→ Todo` and\n```\n→ Todo\n```', t)).toBe('`→ Todo` and\n```\n→ Todo\n```');
  expect(linkRouteTags('→ Sent to the habit session', t)).toBe('→ Sent to the habit session');
});

test('unit: the roots never speak an autoReply (quiet-assess, as the session page)', async () => {
  const { rootsLine } = await import('../lib/roots-voice');
  type Line = {
    reply(c: object, a: object): void;
    giveBack(): void;
    snap: object;
    get(): { phase: string };
    subscribe(f: () => void): () => void;
  };
  const run = (text: string, autoReply?: boolean) => {
    const line = rootsLine() as unknown as Line;
    const phases: string[] = [];
    line.subscribe(() => phases.push(line.get().phase));
    line.giveBack = () => phases.push('mic-back');
    line.snap = { phase: 'working', free: true, slug: 'main', reply: '', note: '' };
    const cycle = { base: { total: 0, lastTime: 0 }, speak: true, idle: true, landed: true, stable: '', replyTime: 0, speaking: false };
    try {
      line.reply(cycle, { role: 'assistant', text, images: [], time: Date.now(), done: true, autoReply });
    } catch {
      /* node has no Audio: the deck can't start here — the phase already said it */
    }
    return phases;
  };
  expect(run('All green, nothing to do.', true)).toEqual(['mic-back']);
  expect(run('OWNER-ACTION: approve the merge.', true)).toContain('speaking');
  expect(run('Here is your answer.')).toContain('speaking');
});

// ── screenshots (TREE_SHOTS=<dir>): phone size, light (drift) + dark (aether) ──
for (const [theme, name] of [
  ['drift', 'light'],
  ['aether', 'dark'],
] as const) {
  test(`shots: home tree + child session, ${name}`, async ({ browser, request }) => {
    test.skip(!process.env.TREE_SHOTS, 'TREE_SHOTS=<dir> to write screenshots');
    const dir = process.env.TREE_SHOTS!;
    const base = test.info().project.use.baseURL!;
    const ctx = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2,
      hasTouch: true,
      storageState: {
        cookies: [],
        origins: [
          {
            origin: new URL(base).origin,
            localStorage: [
              { name: 'bifrost-door', value: 'v2' },
              { name: 'bifrost-first-turn', value: '1' },
              { name: 'theme', value: theme },
            ],
          },
        ],
      },
    });
    const page = await ctx.newPage();
    await bustListCache(request);
    await page.goto(`${base}/`);
    await expect(row(page, 'Recipe photos')).toBeVisible();
    await page.locator('ul > li > button.oz-closed').first().tap(); // MAIN's closed one too
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/root-coord-pwa-home-${name}.png` });
    await page.goto(`${base}/session/static-recipe-site?id=ses_t2erecipesite`);
    await page.getByTestId('session-card').tap();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/root-coord-pwa-child-${name}.png` });
    await page.goto(`${base}/session/main?id=ses_t2emain`);
    await expect(page.locator('a[data-route]').first()).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/root-coord-pwa-main-${name}.png` });
    await ctx.close();
  });
}

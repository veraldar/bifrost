import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

/** Session tool profiles UI (D6 contract, docs/reviews/tool-scope-plan.md).
 *  THE PROBE GOES FIRST: this suite is requirement-driven — the brain
 *  running behind PW_BASE_URL decides which half proves what.
 *
 *  - WITH the feature (root answers GET /profile, e.g. yggdrasil 885122c
 *    + YGG_PROFILES): the picker offers the brain's real list, a session
 *    created on a non-default profile carries the chip in the list and in
 *    the session header, the settings row says fixed; a wrong profile
 *    fails LOUD (the brain 400s, no silent default).
 *  - WITHOUT (GET /profile 404): /api/profile answers {profiles:null} and
 *    the UI is byte-identical default-only — no picker, no chip, no row.
 *
 *  Both halves run on the SIM stack (scripts/sim-stack.sh up → :8096):
 *  nothing here ever touches :8080/:4096/:4100. Path A brings
 *  YGG_PROFILES=lab/yggdrasil/profiles.live.json; Path B swaps the binary
 *  to a pre-profiles build (GET /profile 404). The built tree behind this
 *  suite is the ONLY variable between the paths. */

const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:8096';

type Probe = {
  /** true = the brain serves GET /profile (885122c semantics) */
  has: boolean;
  /** the brain's default profile name (D6 `default: true`) */
  def: string;
  /** a selectable NON-default profile name, or null when only the default exists */
  other: string | null;
};

/** The suite's requirement probe — no assumptions, the live brain decides.
 *  curl, not fetch: this suite runs with the runner on `node --jitless`,
 *  which has no global fetch (the box's hardening; house law: curl in scripts). */
async function probe(): Promise<Probe> {
  const out = execFileSync(
    'curl',
    ['-sf', '-m', '5', `${BASE}/api/profile`],
    { encoding: 'utf8' }
  );
  const d = JSON.parse(out) as {
    profiles: Array<{ name: string; default: boolean }> | null;
  };
  const list = d.profiles;
  if (!Array.isArray(list) || list.length === 0)
    return { has: false, def: 'build', other: null };
  const def = list.find((p) => p.default)?.name || 'build';
  const other = list.find((p) => !p.default)?.name || null;
  return { has: true, def, other };
}

let P: Probe;

test.beforeAll(async () => {
  P = await probe();
  test.info().annotations.push({
    type: 'probe',
    description: `has=${P.has} default=${P.def} other=${P.other}`,
  });
});

/** The create form: open + type the name (+ pick the profile when asked). */
async function openForm(page: import('@playwright/test').Page, profile?: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'new session' }).click();
  const name = `profiles-ui ${Date.now() % 100000}`;
  await page.getByPlaceholder('session name…').fill(name);
  if (profile !== undefined) {
    const sel = page.getByTestId('profile-picker');
    await sel.selectOption(profile);
  }
  return name;
}

test.describe('profiles e2e — WITH the feature (probe: has=true)', () => {
  test.skip(() => !P?.has, 'brain serves no /profile — the WITH half is not required here');

  test('picker lists the brain profile and marks the default', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'new session' }).click();
    const sel = page.getByTestId('profile-picker');
    await expect(sel).toBeVisible();
    const opts = await sel.locator('option').allTextContents();
    // the first option is the brain's default (read from the brain, not
    // hardcoded 'build')
    expect(opts[0]).toContain(`profile: ${P.def} (default)`);
    expect(opts.join('\n')).toContain(P.def);
    if (P.other) expect(opts.join('\n')).toContain(P.other);
  });

  test('create on a non-default profile: header chip + list chip + settings row', async ({
    page,
  }) => {
    test.skip(!P.other, 'single-profile brain — no non-default profile to prove');
    const name = await openForm(page, P.other!);
    await page.getByRole('button', { name: 'create & open' }).click();
    await page.waitForURL(/\/session\//);
    // the header carries the profile chip (info.profile != default)
    const chip = page.getByTestId('header-profile-badge');
    await expect(chip).toHaveText(P.other!);
    // settings: the read-only row names the profile as fixed, no control
    await page.getByRole('link', { name: 'session settings' }).click();
    await expect(page.getByTestId('settings-profile-name')).toHaveText(P.other!);
    await expect(page.getByTestId('settings-profile-state')).toContainText('fixed');
    await expect(page.locator('section:has(h2:text("tool profile")) button')).toHaveCount(0);
    // back to the front: the list row carries the chip too
    await page.goBack();
    await page.goto('/');
    const row = page.locator('li', { hasText: name });
    await expect(row.getByTestId('list-profile-badge')).toHaveText(P.other!);
    // a session created WITHOUT a pick gets the default → no chip anywhere
    const defName = await openForm(page);
    await page.getByRole('button', { name: 'create & open' }).click();
    await page.waitForURL(/\/session\//);
    await expect(page.getByTestId('header-profile-badge')).toHaveCount(0);
    const defRow = page.locator('li', { hasText: defName });
    await expect(defRow.getByTestId('list-profile-badge')).toHaveCount(0);
    // …and its settings row says default
    await page.getByRole('link', { name: 'session settings' }).click();
    await expect(page.getByTestId('settings-profile-name')).toHaveText(P.def);
    await expect(page.getByTestId('settings-profile-state')).toContainText('default');
  });

  test('a wrong profile fails loud — no silent default', async ({ page }) => {
    // the stale-list race, simulated: the UI offers real options, but the
    // brain refuses THIS create (400, D3 fail-closed — e.g. the profile set
    // changed between list render and POST). The proxy forwards the brain's
    // own error; the UI must show it and keep the form, never fall back to
    // creating a default session
    await page.route('**/api/session', async (route) => {
      const body = route.request().postDataJSON() as { profile?: string; name?: string };
      if (body?.profile) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'opencode 400 on /session: unknown profile ' + body.profile,
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'new session' }).click();
    await page.getByPlaceholder('session name…').fill('profiles-ui refusal');
    const pick = P.other || 'quiet';
    await page.getByTestId('profile-picker').selectOption(pick);
    let said = '';
    page.once('dialog', (d) => {
      said = d.message();
      d.accept();
    });
    await page.getByRole('button', { name: 'create & open' }).click();
    await page
      .waitForTimeout(500)
      .then(() => expect(said, 'the brain refusal reaches the user (dialog)').toContain('unknown profile'));
    // the form stays open — retry with a real profile, no silent default
    await expect(page.getByTestId('profile-picker')).toBeVisible();
    // and the refusal dialog carried the brain's own words for THIS profile
    expect(said).toContain(pick);
  });
});

test.describe('profiles e2e — WITHOUT the feature (probe: has=false)', () => {
  test.skip(() => !!P?.has, 'brain serves /profile — the WITHOUT half is not required here');

  test('default-only UI: no picker, create works, no chip, no settings row', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'new session' }).click();
    await expect(page.getByTestId('profile-picker')).toHaveCount(0);
    const name = `profiles-ui plain ${Date.now() % 100000}`;
    await page.getByPlaceholder('session name…').fill(name);
    await page.getByRole('button', { name: 'create & open' }).click();
    await page.waitForURL(/\/session\//);
    await expect(page.getByTestId('header-profile-badge')).toHaveCount(0);
    await page.getByRole('link', { name: 'session settings' }).click();
    await expect(page.locator('section:has(h2:text("tool profile"))')).toHaveCount(0);
    await page.goto('/');
    const row = page.locator('li', { hasText: name });
    await expect(row.getByTestId('list-profile-badge')).toHaveCount(0);
  });
});

import { expect, test } from '@playwright/test';

/** Profiles referee — CATALOG-DERIVED (same law as settings.spec): every
 *  profile id and tool count is read from the SERVED registry
 *  (/api/profiles), never hardcoded — steward/coordinator/scout are being
 *  defined on the box; truth on :8090 today, truth under a stage server
 *  tomorrow. Green by product, never by env. Strictly read-only: the spec
 *  also proves NO edit surface exists (no inputs/buttons in profile blocks).
 *
 *  Run: PW_BASE_URL=http://127.0.0.1:8095 npx playwright test e2e/profile-pages.spec.ts */

type Profile = { id: string; description: string; tools: string[]; isDefault: boolean };

let profiles: Profile[];

test.beforeAll(async ({ request }) => {
  const r = await request.get('/api/profiles');
  expect(r.ok(), 'the served app must expose /api/profiles').toBeTruthy();
  profiles = (await r.json()) as Profile[];
  expect(
    profiles.length,
    'the registry must define at least 3 profiles (steward/coordinator/scout are being defined)'
  ).toBeGreaterThanOrEqual(3);
});

test('list: /settings/profiles shows every registry profile, each row opens its page', async ({
  page,
}) => {
  await page.goto('/settings/profiles');
  await expect(page.getByRole('heading', { name: 'agent profiles' })).toBeVisible();

  // every profile in the served registry is a row, linking to its own page
  const rows = page.getByTestId('profile-row');
  await expect(rows).toHaveCount(profiles.length);
  for (const p of profiles) {
    const row = rows.filter({ hasText: p.id });
    await expect(row.first()).toBeVisible();
    // registry truth: the default is marked, tool counts are shown (the
    // registry's own `*` allow reads as "all tools")
    if (p.isDefault) await expect(row.first()).toContainText('default');
    await expect(row.first()).toContainText(
      p.tools.includes('*') ? 'all tools' : `${p.tools.length} tools`
    );
  }

  // each profile's page opens and carries its OWN name (click through all)
  for (const p of profiles) {
    await page.goto('/settings/profiles');
    await rows.filter({ hasText: p.id }).first().click();
    await expect(page).toHaveURL(new RegExp(`/settings/profiles/${p.id}$`));
    await expect(page.getByTestId('profile-name')).toHaveText(p.id);
  }

  // back-navigation: detail → back → list
  await page.goto(`/settings/profiles/${profiles[0].id}`);
  await page.getByRole('link', { name: 'back' }).click();
  await expect(page).toHaveURL(/\/settings\/profiles$/);
});

test('detail: every profile page renders its granted tools as chips', async ({ page }) => {
  for (const p of profiles) {
    await page.goto(`/settings/profiles/${p.id}`);
    await expect(page.getByTestId('profile-name')).toHaveText(p.id);
    const chips = page.getByTestId('profile-tool');
    await expect(chips).toHaveCount(p.tools.length);
    for (const t of p.tools) {
      await expect(page.getByTestId('profile-tool').filter({ hasText: t }).first()).toBeVisible();
    }
  }
});

test('read-only: profile pages offer no edit surface — no forms, no inputs', async ({ page }) => {
  await page.goto('/settings/profiles');
  await expect(page.getByRole('heading', { name: 'agent profiles' })).toBeVisible();
  await expect(page.locator('input, textarea, select')).toHaveCount(0);
  for (const p of profiles) {
    await page.goto(`/settings/profiles/${p.id}`);
    await expect(page.getByRole('heading', { name: 'allowed tools' })).toBeVisible();
    await expect(page.locator('input, textarea, select')).toHaveCount(0);
  }
});

// The session-settings profile card is gone (root-coord 11-13: the word is AGENT, one agent
// section with each agent's description) — e2e/root-coord-ui.spec.ts referees it.

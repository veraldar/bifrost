import { expect, test } from '@playwright/test';

/** T1 — the version string is the truth of the served build (v07-reflection
 *  §2.3 A, the 10-19 lesson: the sandbox said v0.5.0-74 while calling itself
 *  v0.7). The settings page renders VERSION from package.json, which
 *  sync-version.sh pins to the git tag at release build time — so the page
 *  must name the frozen rc the promote.sh switch will serve, byte for byte.
 *  Brain-agnostic: it only reads the served UI. Skipped unless PW_EXPECT_VERSION
 *  is set, so the daily sandbox run (a worktree, a moving describe) stays
 *  green while the frozen-rc matrix runs get the hard assertion. */

test('T1: settings shows the frozen release version', async ({ page }) => {
  const want = process.env.PW_EXPECT_VERSION;
  test.skip(!want, 'PW_EXPECT_VERSION unset — daily sandbox run, not a frozen-rc check');

  // the settings door is the BIFROST brand link in the header (app/page.tsx)
  await page.goto('/');
  await page.locator('a.oz-brand[href="/settings"]').click();
  await expect(page.getByText(`${want} · a Veraldar product.`)).toBeVisible();
});

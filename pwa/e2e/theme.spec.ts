import { expect, test } from '@playwright/test';

/** Worlds (themes) — the switch stays one attribute: next-themes writes
 *  data-theme on <html>, tokens.css re-scopes every --oz-* color. Settings
 *  draws each world in its own palette; a tap applies at once, persists
 *  across reloads, and the home band is the same tree in the new world. */
const BG = { aether: '#080810', terminus: '#100c14', drift: '#ece8f8' } as const;

const htmlTheme = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.dataset.theme);
const htmlBg = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--oz-bg').trim().toLowerCase()
  );

test('settings: tap a world → applies instantly, persists, tokens follow', async ({ page }) => {
  await page.goto('/settings');
  for (const w of ['terminus', 'drift', 'aether'] as const) {
    const btn = page.getByRole('button', { name: new RegExp(`^${w} —`) });
    await btn.click();
    await expect.poll(() => htmlTheme(page)).toBe(w);
    expect(await htmlBg(page)).toBe(BG[w]);
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    // each world button previews its OWN palette, whatever the current one is
    const own = await btn.evaluate((el) => getComputedStyle(el).getPropertyValue('--oz-bg').trim());
    expect(own.toLowerCase()).toBe(BG[w]);
  }
  await page.getByRole('button', { name: /^terminus —/ }).click();
  await page.reload();
  await expect.poll(() => htmlTheme(page)).toBe('terminus');
  await page.goto('/');
  await expect.poll(() => htmlTheme(page)).toBe('terminus');
  expect(await htmlBg(page)).toBe(BG.terminus);
  // the band is the tree, still unless something works
  await expect(page.getByRole('figure', { name: /your box/ })).toBeVisible();
  // back to the default world so later specs/screens start from aether
  await page.goto('/settings');
  await page.getByRole('button', { name: /^aether —/ }).click();
  await expect.poll(() => htmlTheme(page)).toBe('aether');
});

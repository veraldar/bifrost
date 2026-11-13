import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/** MAINFRAME-C speed budget: the front page must not get slower. A cold
 *  phone-class open of `/` (4× CPU, ~4 Mbps / 100 ms RTT, empty cache), five
 *  runs, medians: first contentful paint, the list on screen, the way to MAIN
 *  on screen (the corner door before, the roots after), and the script bytes
 *  the open itself pulled (before the load event — Link prefetches come
 *  later and are counted apart). SPEED_LABEL names the build in the output
 *  (artifacts/mainframe-c-speed-<label>.json); SPEED_BUDGET_FILE compares. */

const RUNS = Number(process.env.SPEED_RUNS || 5);
const LABEL = process.env.SPEED_LABEL || 'current';
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('speed: cold phone-class open of the front page', async ({ browser, baseURL }) => {
  test.setTimeout(RUNS * 60_000);
  const runs: Record<string, number>[] = [];
  for (let i = 0; i < RUNS; i++) {
    const ctx = await browser.newContext({
      viewport: { width: 412, height: 915 },
      storageState: {
        cookies: [],
        origins: [
          {
            origin: new URL(baseURL!).origin,
            localStorage: [
              { name: 'bifrost-door', value: 'v2' },
              { name: 'bifrost-first-turn', value: '1' },
            ],
          },
        ],
      },
    });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 100,
      downloadThroughput: (4 * 1024 * 1024) / 8,
      uploadThroughput: (1.5 * 1024 * 1024) / 8,
    });
    const t0 = Date.now();
    await page.goto('/', { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: 'BIFROST' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.oz-row').first()).toBeVisible({ timeout: 30_000 });
    const listMs = Date.now() - t0;
    await expect(
      page.locator('[data-testid="tree-door"], [data-testid="roots"]').first()
    ).toBeVisible();
    const entryMs = Date.now() - t0;
    await page.waitForLoadState('load');
    await page.waitForTimeout(2_500); // idle work (prefetches) lands too
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1;
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const js = res.filter((r) => r.initiatorType === 'script' || /\.js(\?|$)/.test(r.name));
      const atLoad = js.filter((r) => r.startTime <= nav.loadEventEnd);
      const sum = (xs: PerformanceResourceTiming[]) =>
        xs.reduce((n, r) => n + (r.transferSize || 0), 0);
      return {
        fcp: Math.round(fcp),
        dcl: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
        jsAtLoadBytes: sum(atLoad),
        jsAtLoadCount: atLoad.length,
        jsAllBytes: sum(js),
        jsAllCount: js.length,
      };
    });
    runs.push({ ...m, listMs, entryMs });
    await ctx.close();
  }
  const keys = Object.keys(runs[0]);
  const med = Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))]));
  const out = { label: LABEL, baseURL, runs, median: med };
  writeFileSync(`../artifacts/mainframe-c-speed-${LABEL}.json`, JSON.stringify(out, null, 2));
  console.log(`speed ${LABEL}: ${JSON.stringify(med)}`);

  const ref = process.env.SPEED_BUDGET_FILE;
  if (ref) {
    const before = (JSON.parse(require('node:fs').readFileSync(ref, 'utf8')) as typeof out).median;
    console.log(`speed before: ${JSON.stringify(before)}`);
    // the budget: no more script on the open, paint and list within noise
    expect(med.jsAtLoadBytes).toBeLessThanOrEqual(before.jsAtLoadBytes * 1.03 + 2048);
    expect(med.fcp).toBeLessThanOrEqual(before.fcp * 1.1 + 50);
    expect(med.listMs).toBeLessThanOrEqual(before.listMs * 1.1 + 100);
  }
});

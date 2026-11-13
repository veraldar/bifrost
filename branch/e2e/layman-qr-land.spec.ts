import { expect, test } from '@playwright/test';

/** layman QR param pickup (a1d6bff): /bridge?t=<token>&b=<bridge-url> —
 *  the QR layman-bootstrap.sh prints encodes exactly this. Params must land
 *  in the form AND localStorage; they WIN over a stale stored pairing (a
 *  re-scan re-pairs, it never resurrects the old device). Without params,
 *  the stored pairing is kept, not clobbered. */
const FRESH = 'bfnd-qr-fresh-token-0123456789abcdef';

test('?t=&b= pre-fill the form and overwrite a stale pairing', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bifrost_device', 'bfnd-stale-token-fedcba9876543210');
    localStorage.setItem('bifrost_bridge', 'http://stale.example:18080');
  });
  await page.goto(`/bridge?t=${FRESH}&b=http%3A%2F%2F127.0.0.1%3A18080`);
  await expect(page.getByTestId('bridge-token')).toHaveValue(FRESH);
  const stored = await page.evaluate(() => ({
    t: localStorage.getItem('bifrost_device'),
    b: localStorage.getItem('bifrost_bridge'),
  }));
  expect(stored.t).toBe(FRESH); // re-pair, not resurrect
  expect(stored.b).toBe('http://127.0.0.1:18080');
});

test('no params keeps the stored pairing untouched', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bifrost_device', 'bfnd-kept-token-9876543210abcdef');
    localStorage.setItem('bifrost_bridge', 'http://kept.example:18080');
  });
  await page.goto('/bridge');
  await expect(page.getByTestId('bridge-token')).toHaveValue(
    'bfnd-kept-token-9876543210abcdef'
  );
  const stored = await page.evaluate(() => ({
    t: localStorage.getItem('bifrost_device'),
    b: localStorage.getItem('bifrost_bridge'),
  }));
  expect(stored.t).toBe('bfnd-kept-token-9876543210abcdef');
  expect(stored.b).toBe('http://kept.example:18080');
});

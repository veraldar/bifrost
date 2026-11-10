import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * v0.9 VALIDATION LADDER — the box + browser "devices" on this machine:
 *   console = desktop context on loopback (the box's own screen → pairing admin)
 *   phone   = iPhone-emulated context dialing the box's LAN address
 *   pixel   = Android-emulated second device
 *
 * pair via QR (the rendered QR is DECODED with zbarimg — no URL is read from
 * the DOM) → token mint (HttpOnly cookie) → land on MAIN → P2P data channel
 * against the QR-pinned box key → app round-trip through the transport (the
 * prompt lands in the MAIN brain session) → a spent QR replays as "used" →
 * revoke from the device list severs the phone mid-session → two live
 * devices, the kill-switch severs everything → re-pair works.
 *
 * Needs the devices-mode server (server.mjs) + the bridge — RELEASE-REPORT.md
 * "run the ladder": PW_DEVICES_MODE=1 PW_LAN_URL=http://<lan-ip>:8095
 * PW_MAIN_SLUG=<slug of BIFROST_MAIN_TITLE>.
 */

const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:8095';
const LAN = process.env.PW_LAN_URL || '';
const MAIN_SLUG = process.env.PW_MAIN_SLUG || 'main';

test.skip(
  process.env.PW_DEVICES_MODE !== '1' || !LAN,
  'the ladder needs the devices-mode server + bridge (RELEASE-REPORT.md)',
);

const scratch = mkdtempSync(join(tmpdir(), 'bfn-ladder-'));
let shots = 0;

async function scanQr(consolePage: Page): Promise<string> {
  await consolePage.goto(`${BASE}/pair`);
  const qr = consolePage.getByTestId('pair-qr');
  await expect(qr.locator('svg')).toBeVisible();
  const file = join(scratch, `qr-${++shots}.png`);
  writeFileSync(file, await qr.screenshot());
  return execFileSync('zbarimg', ['--raw', '-q', file]).toString().trim();
}

async function pairAndLink(page: Page, qrUrl: string) {
  // a fragment-only change is a same-document navigation — start clean
  await page.goto('about:blank');
  await page.goto(qrUrl);
  await page.waitForURL(new RegExp(`/session/${MAIN_SLUG}\\?id=ses_`), { timeout: 30_000 });
  await page.goto(`${LAN}/p2p?session=${MAIN_SLUG}`);
  await expect(page.getByTestId('p2p-phase')).toHaveText('open', { timeout: 30_000 });
}

const pinOf = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('bifrost.pin') || 'null'));

async function apiStatus(ctx: BrowserContext, path: string) {
  return (await ctx.request.get(`${LAN}${path}`)).status();
}

test('v0.9 ladder: QR pair → P2P round-trip → revoke → kill-switch → re-pair', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const box = await desk.newPage();
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await phoneCtx.newPage();
  const pixelCtx = await browser.newContext({ ...devices['Pixel 7'] });
  const pixel = await pixelCtx.newPage();

  let firstQr = '';
  let mainId = '';
  await test.step('1 the box console renders a QR; it decodes to the pairing URL', async () => {
    firstQr = await scanQr(box);
    expect(firstQr.startsWith(`${LAN}/pair#`)).toBe(true);
    const frag = new URLSearchParams(firstQr.split('#')[1]);
    expect(frag.get('code')).toMatch(/^bfnp-/);
    expect(frag.get('fp')).toMatch(/^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(frag.get('bridge')).toMatch(/^http:\/\//);
    await expect(box.getByTestId('pair-fp')).toHaveText(frag.get('fp')!);
  });

  await test.step('2 phone scans: pairs, mints its token, lands on MAIN', async () => {
    await phone.goto(firstQr);
    await phone.waitForURL(new RegExp(`/session/${MAIN_SLUG}\\?id=ses_`), { timeout: 30_000 });
    mainId = new URL(phone.url()).searchParams.get('id')!;
    const cookie = (await phoneCtx.cookies()).find((c) => c.name === 'bifrost_device');
    expect(cookie?.value).toMatch(/^bfnd-/);
    expect(cookie?.httpOnly).toBe(true);
    const pin = await pinOf(phone);
    expect(pin.fp).toBe(new URLSearchParams(firstQr.split('#')[1]).get('fp'));
    expect(await apiStatus(phoneCtx, '/api/ping')).toBe(200);
  });

  await test.step('3 the spent QR replays as used (one-time code)', async () => {
    await pixel.goto('about:blank');
    await pixel.goto(firstQr);
    await expect(pixel.getByTestId('pair-status')).toContainText('already used');
    expect(await apiStatus(pixelCtx, '/api/ping')).toBe(401);
  });

  await test.step('4 P2P data channel opens against the pinned box key', async () => {
    await phone.goto(`${LAN}/p2p?session=${MAIN_SLUG}`);
    await expect(phone.getByTestId('p2p-phase')).toHaveText('open', { timeout: 30_000 });
  });

  const marker = `ladder-${Date.now().toString(36)}`;
  await test.step('5 app round-trip through the transport lands in the MAIN brain session', async () => {
    await phone.getByTestId('p2p-input').fill(`Reply with the single word pong. (${marker})`);
    await phone.getByTestId('p2p-send').click();
    await expect(phone.getByTestId('p2p-reply')).not.toBeEmpty({ timeout: 180_000 });
    await expect(phone.getByTestId('p2p-reply')).not.toContainText('error:');
    // read the brain session back over plain HTTP, as the phone
    const tr = await phoneCtx.request.get(`${LAN}/api/session/${mainId}/messages`);
    expect(tr.status()).toBe(200);
    expect(await tr.text()).toContain(marker);
  });

  await test.step('6 revoke from the device list → the phone is severed mid-session', async () => {
    const { deviceId } = await pinOf(phone);
    await box.goto(`${BASE}/devices`);
    await box.getByTestId(`revoke-${deviceId}`).click();
    await expect(phone.getByTestId('p2p-phase')).toHaveText('severed', { timeout: 10_000 });
    await expect(phone.getByTestId('p2p-why')).toHaveText('revoked');
    expect(await apiStatus(phoneCtx, '/api/ping')).toBe(401);
    await expect(box.getByTestId(`revoked-${deviceId}`)).toBeVisible();
  });

  await test.step('7 two live devices; the kill-switch severs everything', async () => {
    await pairAndLink(phone, await scanQr(box));
    await pairAndLink(pixel, await scanQr(box));
    await box.goto(`${BASE}/devices`);
    box.once('dialog', (d) => d.accept());
    await box.getByTestId('kill-switch').click();
    await expect(box.getByTestId('devices-note')).toContainText(/severed [2-9]\d* device/);
    for (const [page, ctx] of [
      [phone, phoneCtx],
      [pixel, pixelCtx],
    ] as const) {
      await expect(page.getByTestId('p2p-phase')).toHaveText('severed', { timeout: 10_000 });
      await expect(page.getByTestId('p2p-why')).toHaveText('kill-switch');
      expect(await apiStatus(ctx, '/api/ping')).toBe(401);
    }
  });

  await test.step('8 re-pair after the kill-switch works end to end', async () => {
    await pairAndLink(phone, await scanQr(box));
    expect(await apiStatus(phoneCtx, '/api/ping')).toBe(200);
  });

  // the disposable MAIN goes away with the run (the brain keeps no e2e debris)
  if (MAIN_SLUG !== 'main' && mainId) {
    await phoneCtx.request.delete(`${LAN}/api/session/${mainId}`);
  }
  await Promise.all([desk.close(), phoneCtx.close(), pixelCtx.close()]);
});

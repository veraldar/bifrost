import path from 'path';
import { type BrowserContext, type Page, devices, expect, test } from '@playwright/test';

/**
 * v0.9 /bridge — the QR-pinned direct transport, ONE WebRTC session:
 *   the box console mints a QR → the phone claims it (lands on home, pins the
 *   bridge key) → /bridge connects with this device's session token, no
 *   typing → data-channel message round-trip → revoke severs the live link →
 *   a re-paired phone whose pinned key does not match the bridge's answer is
 *   REFUSED before the data channel opens (trust on first scan).
 *
 * Needs the devices-mode server (server.mjs) + the v0.9 bridge (/identity) +
 * a brain — the same box as pair-ladder.spec.ts (scripts/v09-ladder.sh):
 *   PW_DEVICES_MODE=1 PW_BASE_URL=http://127.0.0.1:<port> PW_LAN_URL=http://<lan-ip>:<port>
 * PW_BRIDGE_VOICE=1 adds the voice round-trip (the bridge's speech server;
 * the fake mic speaks a REAL sentence — mic needs a secure origin, so the
 * voice phone dials the loopback address).
 */

const BASE = process.env.PW_BASE_URL || 'http://127.0.0.1:8095';
const LAN = process.env.PW_LAN_URL || '';
const FIXTURE_WAV = path.resolve(__dirname, 'fixtures/bifrost-en.wav');

test.skip(
  process.env.PW_DEVICES_MODE !== '1' || !LAN,
  'needs the devices-mode server + bridge + PW_LAN_URL (pair-ladder.spec.ts)'
);

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FIXTURE_WAV}`,
      // Chrome hides host candidates behind mDNS .local names — str0m cannot
      // resolve those; these flags expose the real addresses
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--allow-loopback-in-peer-connection',
    ],
  },
});

/** the box console's QR payload (loopback = the console; no admin token) */
async function qrUrl(ctx: BrowserContext): Promise<string> {
  const r = await ctx.request.post(`${BASE}/api/pair/code`);
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.fingerprint).toMatch(/^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  return body.url as string;
}

async function pair(page: Page, url: string) {
  await page.goto('about:blank'); // a fragment-only change is a same-document navigation
  await page.goto(url);
  await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 }); // home: the door or the list
}

async function connect(page: Page, origin: string, bridgeHost?: string) {
  await page.goto(`${origin}/bridge`);
  await expect(page.getByTestId('bridge-pin')).toContainText('box key sha-256');
  if (bridgeHost) {
    // same bridge, another address — the pin still decides
    const url = new URL(await page.getByTestId('bridge-url').inputValue());
    url.hostname = bridgeHost;
    await page.getByTestId('bridge-url').fill(url.origin);
  }
  await page.getByTestId('bridge-connect').click();
}

test('QR pair → pinned bridge → message round-trip → revoke severs → wrong key refused', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const desk = await browser.newContext();
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await phoneCtx.newPage();

  await test.step('1 phone claims the QR: lands on home, pins the box key', async () => {
    const url = await qrUrl(desk);
    expect(url.startsWith(`${LAN}/pair#`)).toBe(true);
    await pair(phone, url);
    const pin = await phone.evaluate(() => JSON.parse(localStorage.getItem('bifrost.pin') || '{}'));
    expect(pin.fp).toBe(new URLSearchParams(url.split('#')[1]).get('fp'));
    expect(pin.bridge).toMatch(/^http:\/\//);
  });

  await test.step('2 /bridge connects with the session token, against the pinned key', async () => {
    await connect(phone, LAN);
    await expect(phone.getByTestId('bridge-state')).toHaveText(/^connected/, { timeout: 30_000 });
    await expect(phone.getByTestId('bridge-log')).toContainText('box key pinned');
    await expect(phone.getByTestId('bridge-log')).toContainText(/channel RTT ~\d+ms/);
  });

  const word = `BRIDGE-OK-${Date.now().toString(36)}`;
  await test.step('3 message round-trip over the data channel (a real brain run)', async () => {
    await phone.getByTestId('bridge-input').fill(`Reply with exactly: ${word}`);
    await phone.getByTestId('bridge-send').click();
    await expect(phone.locator('[data-testid=bridge-log] [data-who=bifrost]')).toContainText(word, {
      timeout: 180_000,
    });
  });

  await test.step('4 revoking the device severs the live link', async () => {
    const { deviceId } = await phone.evaluate(() =>
      JSON.parse(localStorage.getItem('bifrost.pin') || '{}')
    );
    const r = await desk.request.delete(`${BASE}/api/pair/devices`, { data: { id: deviceId } });
    expect(r.status()).toBe(200);
    await expect(phone.getByTestId('bridge-state')).toHaveText(/^severed: revoked/, {
      timeout: 10_000,
    });
  });

  await test.step('5 a pinned key the bridge does not hold is refused (no channel)', async () => {
    await pair(phone, await qrUrl(desk)); // fresh, valid credentials
    await phone.evaluate(() => {
      const pin = JSON.parse(localStorage.getItem('bifrost.pin') || '{}');
      const last = pin.fp.slice(-1);
      pin.fp = pin.fp.slice(0, -1) + (last === '0' ? '1' : '0');
      localStorage.setItem('bifrost.pin', JSON.stringify(pin));
    });
    await connect(phone, LAN);
    await expect(phone.getByTestId('bridge-state')).toContainText('refused', { timeout: 30_000 });
    await expect(phone.getByTestId('bridge-state')).toContainText('box key this phone pinned');
    await phone.waitForTimeout(2000);
    await expect(phone.getByTestId('bridge-state')).not.toContainText('connected');
  });

  await Promise.all([desk.close(), phoneCtx.close()]);
});

test('voice round-trip over the pinned bridge', async ({ browser }) => {
  test.skip(
    process.env.PW_BRIDGE_VOICE !== '1',
    'needs the bridge speech server (PW_BRIDGE_VOICE=1)'
  );
  test.setTimeout(300_000);
  // the mic opens on a secure origin only: this phone is the loopback one
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await pair(page, (await qrUrl(ctx)).replace(LAN, BASE));
  // its token is bound to the loopback region: dial the bridge there too
  await connect(page, BASE, '127.0.0.1');
  await expect(page.getByTestId('bridge-state')).toHaveText(/^connected/, { timeout: 30_000 });
  await page.getByTestId('bridge-input').fill('Reply with exactly: VOICE-READY');
  await page.getByTestId('bridge-send').click();
  await expect(page.locator('[data-testid=bridge-log] [data-who=bifrost]')).toContainText(
    'VOICE-READY',
    { timeout: 180_000 }
  );
  await page.getByTestId('bridge-ptt').dispatchEvent('mousedown');
  await page.waitForTimeout(1800); // hold long enough for the fake file to loop into the track
  await page.getByTestId('bridge-ptt').dispatchEvent('mouseup');
  await expect(page.getByTestId('bridge-voice')).toContainText('reply audio:', {
    timeout: 240_000,
  });
  expect(await page.getByTestId('bridge-voice').textContent()).toMatch(/reply audio: \d+ frames/);
  await ctx.close();
});

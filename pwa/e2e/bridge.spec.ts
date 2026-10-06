import { expect, test } from '@playwright/test';
import path from 'path';

/**
 * v0.9 no-tailscale full flow — ONE browser, ONE WebRTC session:
 *   pair (token) → bridge connect → data-channel message round-trip →
 *   voice round-trip (fake mic speaks a REAL sentence, bridge STTs it,
 *   opencode answers, TTS audio comes back as frames).
 */

const FIXTURE_WAV = path.resolve(__dirname, 'fixtures/voice.wav');

// the fake mic speaks a REAL sentence (fixture WAV) — whisper can hear it
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FIXTURE_WAV}`,
      // Chrome hides host candidates behind mDNS .local names on localhost —
      // str0m cannot resolve those; these flags expose real loopback IPs
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--allow-loopback-in-peer-connection',
    ],
  },
});

test('pair → data-channel session → message round-trip → voice round-trip', async ({
  page,
}) => {
    test.setTimeout(300_000);

    // 1. PAIR: mint a device token through the pairing surface
    await page.goto('/pair');
    await page.locator('input').first().fill('e2e-phone');
    await page.getByText('Pair this device').click();
    await expect(page.locator('code')).toContainText('bfnd-', { timeout: 10_000 });
    // the pair page stored the token; the bridge page picks it up
    const stored = await page.evaluate(() => localStorage.getItem('bifrost_device'));
    expect(stored).toMatch(/^bfnd-/);

    // 2. CONNECT: one RTCPeerConnection to the bridge
    page.on('request', (r) => {
      if (r.url().includes('18080')) console.log('[spec] REQ', r.method(), r.url());
    });
    page.on('response', (r) => {
      if (r.url().includes('18080')) console.log('[spec] RESP', r.status(), r.url());
    });
    page.on('console', (m) => {
      if (m.text().startsWith('[v9]')) console.log('[page]', m.text());
    });
    await page.goto('/bridge');
    await page.getByTestId('bridge-connect').click();
    await expect(page.getByTestId('bridge-state')).toContainText('connected', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('bridge-log')).toContainText('channel RTT', {
      timeout: 10_000,
    });

    // 3. MESSAGE ROUND-TRIP over the data channel (real opencode run)
    await page
      .getByTestId('bridge-input')
      .fill('Reply with exactly: BRIDGE-OK and nothing else.');
    await page.getByTestId('bridge-send').click();
    await expect(page.getByTestId('bridge-log')).toContainText('BRIDGE-OK', {
      timeout: 180_000,
    });

    // 4. VOICE ROUND-TRIP: fake mic speaks the fixture; bridge STTs + TTSs back
    await page.getByTestId('bridge-ptt').dispatchEvent('mousedown');
    // hold long enough for the fake file to loop into the track
    await page.waitForTimeout(1800);
    await page.getByTestId('bridge-ptt').dispatchEvent('mouseup');
    await expect(page.getByTestId('bridge-voice')).toContainText('reply audio:', {
      timeout: 240_000,
    });
  const voiceLine = await page.getByTestId('bridge-voice').textContent();
  expect(voiceLine).toMatch(/reply audio: \d+ frames/);
  expect(voiceLine).toMatch(/RTT \d+ms/);
});

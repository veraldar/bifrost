#!/usr/bin/env node
/**
 * layman-scan-sim.mjs — the scan-simulate leg of the layman QR flow.
 *
 * Simulates what a friend's phone does with the QR the bootstrap prints:
 *   1. SCANS  — decodes the QR PNG (zbar) into the payload URL
 *   2. LANDS  — opens the payload in a headless phone-shaped Chromium (via PW_BASE_URL,
 *               PW_JITLESS=1 + --jitless: this shell runs under MemoryDenyWriteExecute)
 *   3. JOINS  — tap Connect → WebRTC offer POST /offer with the QR's Bearer token →
 *               data channel `hello` → "connected"
 *   4. TALKS  — one PTT turn: fake mic speaks e2e/fixtures/voice.wav → trunk STTs it →
 *               the brain answers → TTS frames come back ("reply audio: N frames")
 *
 * STAGE MUST ALREADY BE DEPLOYED (lab/layman-deploy/impl/layman-bootstrap.sh --stage):
 * this runner never starts, restarts or stops the stack — pure client-side proof.
 *
 * Env:  PW_BASE_URL (default http://127.0.0.1:8080 — set it to the stage app!)
 *       PW_QR (default: the bootstrap's /tmp/layman-qr/pair-qr.png)
 *       PW_JITLESS=1 (chromium --js-flags=--jitless)
 *       PW_HEADLESS=0 to watch it
 * Usage: node --jitless scripts/layman-scan-sim.mjs [--stage]
 *   --stage  e2e-leg A: assert the STAGE itself (no QR decode): /api/build answers,
 *            /pair page renders, trunk POST /offer 401s without a token.
 * Exit 0 = green.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// playwright lives in pwa/node_modules — this script sits in scripts/, where ESM
// resolution cannot see it; fall back to the explicit path.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import(
    pathToFileURL(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../pwa/node_modules/playwright/index.mjs')).href
  ));
}

const BASE = (process.env.PW_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const QR = process.env.PW_QR || '/tmp/layman-qr/pair-qr.png';
const STAGE_MODE = process.argv.includes('--stage');
const HEADLESS = process.env.PW_HEADLESS !== '0';
const WAV = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../pwa/e2e/fixtures/voice.wav');

const log = (...a) => console.log('[scan-sim]', ...a);
const die = (m) => { console.error('[scan-sim] FAIL:', m); process.exit(1); };

// ---------- leg 1: SCAN ----------
let payload;
if (!STAGE_MODE) {
  if (!fs.existsSync(QR)) die(`QR file missing: ${QR} — run layman-bootstrap.sh first`);
  try {
    payload = execFileSync('zbarimg', ['--quiet', '--raw', QR], { encoding: 'utf8' }).trim();
  } catch (e) {
    die(`QR decode failed: ${e.message}`);
  }
  if (!/^https?:\/\//.test(payload)) die(`QR payload is not a URL: ${payload.slice(0, 80)}`);
  log('SCANNED ✓ payload:', payload);
  const u = new URL(payload);
  if (!u.pathname.endsWith('/bridge') || !u.searchParams.get('t')) {
    die(`payload does not carry /bridge + token: ${u.pathname}`);
  }
  // The headless client joins the LOOPBACK TWIN of the scanned origin (same
  // app + trunk + token, PW_BASE_URL host). Reason: plain-LAN http origins are
  // NOT secure contexts — getUserMedia is unavailable there, and headless_shell
  // ignores --unsafely-treat-insecure-origin-as-secure. Real phones get https
  // (tailscale serve / LAN cert) — recorded as a deploy finding in the report.
  if (u.origin !== BASE) {
    payload = `${BASE}${u.pathname}${u.search}`;
    log(`sim: joining the loopback twin ${payload} (LAN origin needs https on real phones)`);
  }
  if (u.origin !== BASE) log(`note: QR origin ${u.origin} ≠ PW_BASE_URL ${BASE} (scenario headless joins via PW_BASE_URL)`);
} else {
  log('--stage: skipping QR decode, asserting the stage directly');
}

const launchArgs = [
  '--use-fake-ui-for-media-stream',            // auto-grant mic
  '--use-fake-device-for-media-stream',        // synthetic audio device
  `--use-file-for-fake-audio-capture=${WAV}`,  // the mic "speaks" the real-speech fixture
  '--disable-features=WebRtcHideLocalIpsWithMdns', // bridge (str0m) needs real loopback IPs
  '--allow-loopback-in-peer-connection',
  ...(process.env.PW_JITLESS ? ['--js-flags=--jitless'] : []), // hardened-shell rule (AGENTS.md)
  // chromium's own sandbox crashes its renderers when launched from a systemd
  // user unit / hardened cgroup (the on-box lab reality) — PW_NO_SANDBOX=1 opts out
  ...(process.env.PW_NO_SANDBOX ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
];
fs.existsSync(WAV) || die(`voice fixture missing: ${WAV}`);
const browser = await chromium.launch({ headless: HEADLESS, args: launchArgs });
const page = await browser.newPage({ viewport: { width: 360, height: 780 } }); // phone shape
page.setDefaultTimeout(30000);
try {
  if (STAGE_MODE) {
    // e2e-leg A: the stage answers and the pairing surface exists
    const build = await (await fetch(`${BASE}/api/build`)).json();
    if (!build.id || build.id === 'unknown') die(`stage /api/build malformed: ${JSON.stringify(build)}`);
    log('STAGE ✓ /api/build:', build.id);
    await page.goto(`${BASE}/pair`);
    (await page.getByText('Pair this device').count()) || die('pair page did not render');
    log('STAGE ✓ /pair renders (the pairing surface the token was minted through)');
    process.exit(0);
  }

  // ---------- leg 2+3: LAND + JOIN (exactly the QR-open path) ----------
  await page.goto(payload); // the scanned URL — no manual token paste, no devtools
  const t = await page.getByTestId('bridge-token').inputValue();
  if (!t.startsWith('bfnd-')) die(`bridge page did not pick up the QR token (got: "${t.slice(0, 12)}…")`);
  log('LANDED ✓ /bridge pre-filled from the QR (token bfnd-…', t.slice(-6) + ')');
  await page.getByTestId('bridge-connect').click();
  await page.getByTestId('bridge-state').filter({ hasText: 'connected' }).waitFor({ timeout: 30000 });
  await page.getByTestId('bridge-log').filter({ hasText: 'channel RTT' }).waitFor({ timeout: 10000 });
  log('JOINED ✓ bridge connected (WebRTC offer accepted with the QR Bearer token, channel open)');

  // ---------- leg 4: TALK (one voice turn) ----------
  await page.getByTestId('bridge-input').fill('Reply with exactly: LAYMAN-OK');
  await page.getByTestId('bridge-send').click();
  await page.getByTestId('bridge-log').filter({ hasText: 'LAYMAN-OK' }).waitFor({ timeout: 60000 });
  log('TALK ✓ one text turn round-tripped through the brain (LAYMAN-OK)');

  await page.getByTestId('bridge-ptt').dispatchEvent('mousedown');
  await page.waitForTimeout(1800); // let the fake file loop into the track
  await page.getByTestId('bridge-ptt').dispatchEvent('mouseup');
  await page
    .getByTestId('bridge-voice')
    .filter({ hasText: 'reply audio:' })
    .waitFor({ timeout: 120000 });
  const v = await page.getByTestId('bridge-voice').textContent();
  const m = v.match(/reply audio: (\d+) frames.*RTT (\d+)ms/);
  log(`VOICE ✓ one spoken turn: ${m ? m[1] + ' frames, commit→reply ' + m[2] + 'ms' : v}`);
  console.log('\nGREEN — scan → land → join → talk, all four legs.');
} catch (e) {
  const state = await page.getByTestId('bridge-state').textContent().catch(() => '?');
  const vstate = await page.getByTestId('bridge-voice').textContent().catch(() => '?');
  die(`${e.message.split('\n')[0]} | bridge-state="${state}" voice="${vstate}"`);
} finally {
  await browser.close().catch(() => {});
}

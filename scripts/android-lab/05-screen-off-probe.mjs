// screen-off mic probe (native-app-eval Rung 0): does Android Chrome keep the
// hands-free mic track and the LiveKit room alive through 60s of screen-off?
// runs ON the Mac via 05-screen-off-probe.sh. exit 0 PASS / 1 RED / 2 INCONCLUSIVE.
import { _android as android } from 'playwright';
import fs from 'node:fs';

const SHOTS = process.argv[2] || '/tmp/android-lab-screen-off';
const PWA_URL = process.env.PWA_URL || 'http://localhost:8080';
const LK_HOST = process.env.LK_HOST; // the box's tailnet name — docs/local.md (private)
if (!LK_HOST) { console.error('set LK_HOST (docs/local.md)'); process.exit(2); }
const LK_LOCAL = process.env.LK_LOCAL || '127.0.0.1:18443';
const OFF_MS = Number(process.env.OFF_MS || 60_000);
const NAME = `screen-off-${Date.now().toString(36)}`;
const report = { startedAt: new Date().toISOString(), pwaUrl: PWA_URL, name: NAME, offMs: OFF_MS, steps: {}, samples: [] };
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const finish = (result, reason, code) => {
  report.result = result;
  report.reason = reason;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(`${SHOTS}/report.json`, JSON.stringify(report, null, 2));
  console.log(`PROBE RESULT: ${result} reason=${reason}`);
  process.exit(code);
};

android.setDefaultTimeout(60_000);
const devices = await android.devices();
if (!devices.length) finish('INCONCLUSIVE', 'no-adb-device', 2);
const device = devices[0];
const sh = async (cmd) => (await device.shell(cmd)).toString().trim();
const wakefulness = async () => (await sh('dumpsys power | grep mWakefulness=')).replace(/.*=/, '');
const shot = async (file) => fs.writeFileSync(`${SHOTS}/${file}`, await device.screenshot());

await sh('settings put global window_animation_scale 0');
// Chrome's "notifications make things easier" promo covers the page mid-run; granting
// the permission up front stops it surfacing at all
await sh('pm grant com.android.chrome android.permission.POST_NOTIFICATIONS').catch(() => {});
await sh('input keyevent 224'); // WAKEUP (idempotent, unlike 26)
await sh('wm dismiss-keyguard');

const context = await device.launchBrowser({
  pkg: 'com.android.chrome',
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    // LiveKit signal is the tailnet TLS alias; the AVD reaches it via ssh -R + adb reverse.
    // SNI/cert stay on the real hostname — only DNS is rewritten.
    `"--host-resolver-rules=MAP ${LK_HOST} ${LK_LOCAL}"`,
  ],
});
await sleep(2500);
await device.tap(577, 1742).catch(() => {}); // first-run sheet "No thanks" (see 04)
context.setDefaultTimeout(60_000);

// instrument before any page script: every WebSocket, RTCPeerConnection and
// getUserMedia track, with timestamped lifecycle events.
await context.addInitScript(() => {
  const P = (window.__probe = { ws: [], pcs: [], tracks: [], events: [] });
  const ev = (k, d) => P.events.push({ t: Date.now(), k, ...d });
  const OWS = window.WebSocket;
  window.WebSocket = new Proxy(OWS, {
    construct(T, args) {
      const w = Reflect.construct(T, args);
      const i = P.ws.push(w) - 1;
      w.__url = String(args[0]).split('?')[0];
      ev('ws-new', { i, url: w.__url });
      w.addEventListener('open', () => ev('ws-open', { i }));
      w.addEventListener('close', (e) => ev('ws-close', { i, code: e.code }));
      return w;
    },
  });
  const OPC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(OPC, {
    construct(T, args) {
      const pc = Reflect.construct(T, args);
      const i = P.pcs.push(pc) - 1;
      ev('pc-new', { i });
      pc.addEventListener('connectionstatechange', () => ev('pc-state', { i, state: pc.connectionState }));
      return pc;
    },
  });
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    const s = await gum(c);
    for (const t of s.getAudioTracks()) {
      const i = P.tracks.push(t) - 1;
      t.__owner = window.__probeOwn ? 'probe' : 'pwa';
      ev('track-new', { i, owner: t.__owner, label: t.label });
      t.addEventListener('ended', () => ev('track-ended', { i }));
      t.addEventListener('mute', () => ev('track-mute', { i }));
      t.addEventListener('unmute', () => ev('track-unmute', { i }));
    }
    return s;
  };
  document.addEventListener('visibilitychange', () => ev('visibility', { state: document.visibilityState }));
});

const page = await context.newPage();
page.on('pageerror', (e) => (report.pageErrors ||= []).push(String(e).slice(0, 200)));

// one snapshot of everything the probe asserts on
const snapshot = () =>
  page.evaluate(async () => {
    const P = window.__probe;
    const rtcWs = P.ws.map((w, i) => ({ i, url: w.__url, state: w.readyState })).filter((w) => w.url.includes('/rtc'));
    const pcs = [];
    for (const [i, pc] of P.pcs.entries()) {
      let bytesSent = 0, bytesReceived = 0;
      try {
        (await pc.getStats()).forEach((s) => {
          if (s.type === 'outbound-rtp' && s.kind === 'audio') bytesSent += s.bytesSent || 0;
          if (s.type === 'inbound-rtp' && s.kind === 'audio') bytesReceived += s.bytesReceived || 0;
        });
      } catch {}
      pcs.push({ i, state: pc.connectionState, bytesSent, bytesReceived });
    }
    return {
      t: Date.now(),
      visibility: document.visibilityState,
      rtcWs,
      pcs,
      tracks: P.tracks.map((t, i) => ({ i, owner: t.__owner, readyState: t.readyState, muted: t.muted, enabled: t.enabled })),
      handsFree: !!document.querySelector('[aria-label="leave hands-free"]'),
    };
  });
const roomConnected = (s) => s.rtcWs.some((w) => w.state === 1) && s.pcs.some((p) => p.state === 'connected');

// Chrome's first-run notification sheet can surface late, over the page
const dismissSheet = async () => {
  await device.tap({ text: 'No thanks' }, { timeout: 3000 }).catch(() => {});
};

const step = async (label, fn) => {
  const t0 = Date.now();
  try {
    const out = await fn();
    report.steps[label] = { ok: true, ms: Date.now() - t0, ...(out || {}) };
    console.log(`PASS ${label} (${Date.now() - t0}ms)`);
  } catch (e) {
    report.steps[label] = { ok: false, ms: Date.now() - t0, error: String(e).slice(0, 400) };
    console.log(`FAIL ${label}: ${String(e).slice(0, 300)}`);
    throw e;
  }
};

let pre;
try {
  await step('open-session', async () => {
    await page.goto(PWA_URL, { waitUntil: 'load', timeout: 90_000 });
    await page.getByRole('button', { name: 'new session' }).click();
    await page.getByPlaceholder('session name…').fill(NAME);
    await page.getByRole('button', { name: 'create & open' }).click();
    await page.waitForURL(new RegExp(`/session/${NAME}`), { timeout: 30_000 });
    // hard load: client-side nav can hit a stale chunk after a redeploy (ChunkLoadError seen in lab)
    await page.goto(`${PWA_URL}/session/${NAME}`, { waitUntil: 'load', timeout: 90_000 });
    await dismissSheet();
  });

  await step('room-connect', async () => {
    // the session page auto-connects the voice room (mic off) on open
    for (let i = 0; i < 30; i++) {
      if (roomConnected(await snapshot())) return { connected: true };
      await sleep(1000);
    }
    return { connected: false };
  });

  await step('enter-hands-free', async () => {
    const ptt = page.getByRole('button', { name: 'push to talk' });
    await ptt.waitFor({ timeout: 30_000 });
    try { await ptt.click({ timeout: 5000 }); } catch { await ptt.click({ force: true }); } // tap = toggle (see 04 finding 2)
    try {
      await page.getByRole('button', { name: 'leave hands-free' }).waitFor({ timeout: 20_000 });
      await sleep(3000); // let the mic publish
      // the strip renders before the room is up — hands-free only counts once the PWA holds a mic track
      const pwaTrack = (await snapshot()).tracks.some((t) => t.owner === 'pwa' && t.readyState === 'live');
      return { handsFree: pwaTrack, strip: true };
    } catch {
      return { handsFree: false };
    }
  });

  await step('probe-track', async () => {
    // the eval's minimal honest proxy, always taken alongside the PWA's own mic
    const st = await page.evaluate(async () => {
      window.__probeOwn = true;
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      window.__probeOwn = false;
      return s.getAudioTracks()[0]?.readyState;
    });
    if (st !== 'live') throw new Error(`probe track not live before screen-off: ${st}`);
    return { readyState: st };
  });

  pre = await snapshot();
  report.pre = pre;
  await shot('01-before-off.png');
} catch (e) {
  report.fatal = String(e).slice(0, 400);
  try { await shot('99-failure.png'); } catch {}
  finish('INCONCLUSIVE', `setup-failed:${report.steps && Object.keys(report.steps).find((k) => !report.steps[k].ok)}`, 2);
}

const roomPre = roomConnected(pre);
const offAt = Date.now();
await sh('input keyevent 26');
await sleep(2000);
report.wakefulnessOff = await wakefulness();
console.log(`screen off (wakefulness=${report.wakefulnessOff}), holding ${OFF_MS / 1000}s…`);
for (let held = 2000; held < OFF_MS; held += 15_000) {
  await sleep(Math.min(15_000, OFF_MS - held));
  try { report.samples.push(await snapshot()); } catch (e) { report.samples.push({ t: Date.now(), error: String(e).slice(0, 200) }); }
}
const onAt = Date.now();
await sh('input keyevent 224');
await sh('wm dismiss-keyguard');
report.wakefulnessOn = await wakefulness();
const atWake = await snapshot();
await sleep(5000);
const post = await snapshot();
report.atWake = atWake;
report.post = post;
await shot('02-after-on.png');

const events = await page.evaluate(() => window.__probe.events);
report.events = events;
const during = events.filter((e) => e.t >= offAt && e.t <= post.t);
report.eventsDuringWindow = during;
await context.close().catch(() => {});

if (report.wakefulnessOff === 'Awake') finish('INCONCLUSIVE', 'screen-never-went-off', 2);

// track verdict: every captured audio track (PWA hands-free mic + probe's) stays live
const preTracks = new Set(pre.tracks.filter((t) => t.readyState === 'live').map((t) => t.i));
const deadTracks = post.tracks.filter((t) => preTracks.has(t.i) && t.readyState !== 'live').map((t) => `${t.owner}#${t.i}`);
const endedDuring = during.filter((e) => e.k === 'track-ended').map((e) => e.i);
const mutedDuring = during.filter((e) => e.k === 'track-mute').map((e) => e.i);
report.track = { checked: [...preTracks], deadTracks, endedDuring, mutedDuring };

// room verdict: the signal ws and peer connections live at screen-off never dropped
// (a later reconnect still counts as a death — the turn would have been lost)
const preWs = new Set(pre.rtcWs.filter((w) => w.state === 1).map((w) => w.i));
const prePcs = new Set(pre.pcs.filter((p) => p.state === 'connected').map((p) => p.i));
const wsClosed = during.filter((e) => e.k === 'ws-close' && preWs.has(e.i)).map((e) => e.i);
const pcDropped = during.filter((e) => e.k === 'pc-state' && prePcs.has(e.i) && e.state !== 'connected').map((e) => `${e.i}:${e.state}`);
const newRtcWs = during.filter((e) => e.k === 'ws-new' && e.url.includes('/rtc')).length;
const pubBytes = (s) => s.pcs.reduce((a, p) => a + p.bytesSent, 0);
report.room = {
  connectedBefore: roomPre,
  connectedAfter: roomConnected(post),
  wsClosed,
  pcDropped,
  newRtcWs,
  micBytesSentDuringOff: pubBytes(atWake) - pubBytes(pre),
};

const warn = [];
if (!report.steps['enter-hands-free']?.handsFree) warn.push('hands-free-not-entered');
if (mutedDuring.length) warn.push(`muted:${mutedDuring.join(',')}`);
if (roomPre && report.room.micBytesSentDuringOff === 0) warn.push('no-mic-bytes-while-off');
const w = warn.length ? ` warn=${warn.join('|')}` : '';

if (deadTracks.length || endedDuring.length) finish('RED', `track-ended:${[...new Set([...deadTracks, ...endedDuring])].join(',')}${w}`, 1);
if (!roomPre) finish('INCONCLUSIVE', `track-live but room never connected before screen-off (lab cannot reach LiveKit)${w}`, 2);
if (wsClosed.length || pcDropped.length || newRtcWs || !report.room.connectedAfter)
  finish('RED', `room-died:ws-closed=${wsClosed.length},pc-dropped=${pcDropped.join(',') || 0},reconnects=${newRtcWs},connected-after=${report.room.connectedAfter}${w}`, 1);
finish('PASS', `track-live room-alive off=${Math.round((onAt - offAt) / 1000)}s mic-bytes-while-off=${report.room.micBytesSentDuringOff}${w}`, 0);

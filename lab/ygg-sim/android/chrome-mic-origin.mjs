#!/usr/bin/env node
// chrome-mic-origin.mjs — does ANDROID Chrome let a page open the mic on origin X?
//
// Drives the real Chrome on a booted AVD through raw CDP (adb forward →
// chrome_devtools_remote; zero npm deps: Node's global fetch + WebSocket).
// Per origin it records: what the address bar shows, window.isSecureContext,
// typeof navigator.mediaDevices, the microphone permission state before/after,
// the REAL Chrome permission prompt (text + screenshot; tapped "Allow" via
// uiautomator — no --use-fake-ui flag), and the getUserMedia outcome against
// the emulator's virtual mic (zeros — host audio is never forwarded).
//
// Origins (--origins id=url,...; special urls):
//   @lan        plain http on a NON-loopback address: a loopback-only page server
//               reached via the emulator's host alias 10.0.2.2 (same secure-context
//               class as a LAN IP like 192.168.x.y — nothing listens on the LAN)
//   @localhost  the same page via `adb reverse` at http://localhost:<port>
//
// Output: one JSON document on stdout. --redact HOST replaces HOST with
// <tailnet-host> in the JSON (screenshots are raw; keep them out of git).
// Usage: node chrome-mic-origin.mjs --adb ADB --serial S --origins A=https://h/,B=https://h:8443/,C=@lan,D=@localhost [--shots DIR] [--redact HOST]

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const ADB = args.adb || 'adb';
const SERIAL = args.serial;
const SHOTS = args.shots || '';
const REDACT = args.redact || '';
const CHROME = 'com.android.chrome';
const log = (...a) => console.error('[chrome-mic]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const adbRaw = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { maxBuffer: 64 << 20 });
const sh = (cmd) => adb('shell', cmd);

// ---- loopback page server (origins C and D) ----
const page = `<!doctype html><meta name=viewport content="width=device-width"><title>ygg-sim mic probe</title>
<body style="font:16px sans-serif;padding:16px"><h2>ygg-sim mic probe</h2><p id=o></p>
<script>document.getElementById('o').textContent=location.origin+' secure='+isSecureContext</script>`;
const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  r.end(page);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const lport = server.address().port;
adb('reverse', `tcp:${lport}`, `tcp:${lport}`);

const origins = (args.origins || '').split(',').filter(Boolean).map((kv) => {
  const [id, ...rest] = kv.split('=');
  let url = rest.join('=');
  if (url === '@lan') url = `http://10.0.2.2:${lport}/`;
  if (url === '@localhost') url = `http://localhost:${lport}/`;
  return { id, url };
});

// ---- Chrome: clean profile, real prompts, devtools socket ----
sh(`am force-stop ${CHROME}`);
sh(`pm clear ${CHROME}`); // per-origin permission state starts empty every run
sh(`pm grant ${CHROME} android.permission.RECORD_AUDIO`); // the OS-level grant a phone user gives once
try { sh(`pm grant ${CHROME} android.permission.POST_NOTIFICATIONS`); } catch {}
sh(`echo '_ --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line; chmod 644 /data/local/tmp/chrome-command-line`);
sh(`am set-debug-app --persistent ${CHROME}`);
sh(`am start -n ${CHROME}/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d about:blank`);
const chromeVersion = (sh(`dumpsys package ${CHROME}`).match(/versionName=(\S+)/) || [])[1];
const android = sh('getprop ro.build.version.release').trim();

let socketUp = false;
for (let i = 0; i < 60 && !socketUp; i++) {
  socketUp = sh('cat /proc/net/unix').includes('@chrome_devtools_remote');
  if (!socketUp) await sleep(500);
}
if (!socketUp) {
  console.log(JSON.stringify({ error: 'chrome devtools socket never appeared' }));
  process.exit(2);
}
const fport = adb('forward', 'tcp:0', 'localabstract:chrome_devtools_remote').trim();
const base = `http://127.0.0.1:${fport}`;

async function pageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${base}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p;
    } catch {}
    await sleep(500);
  }
  throw new Error('no page target');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      else if (m.method) this.listeners.forEach((l) => l(m));
    };
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this.pending.set(id, r));
  }
  waitEvent(name, ms) {
    return new Promise((r) => {
      const t = setTimeout(() => r(null), ms);
      this.listeners.push((m) => { if (m.method === name) { clearTimeout(t); r(m); } });
    });
  }
  async eval(expr, ms = 30000) {
    const res = await Promise.race([
      this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      sleep(ms).then(() => ({ timeout: true })),
    ]);
    if (res.timeout) return { __timeout: true };
    if (res.result?.exceptionDetails) return { __exception: res.result.exceptionDetails.text };
    return res.result?.result?.value;
  }
}

// ---- UI helpers (the real permission prompt) ----
function uiNodes() {
  try {
    sh('uiautomator dump /sdcard/ygg-ui.xml >/dev/null 2>&1');
    const xml = sh('cat /sdcard/ygg-ui.xml');
    return [...xml.matchAll(/<node [^>]*?>/g)].map((m) => {
      const a = (k) => (m[0].match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || '';
      const b = a('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      return { text: a('text'), id: a('resource-id'), cls: a('class'), bounds: b ? b.slice(1).map(Number) : null };
    });
  } catch { return []; }
}
const ALLOW = /^(allow|allow this time|allow while visiting the site|allow on every visit|while using the app)$/i;
function shot(name) {
  if (!SHOTS) return null;
  fs.mkdirSync(SHOTS, { recursive: true });
  const f = path.join(SHOTS, name);
  fs.writeFileSync(f, adbRaw('exec-out', 'screencap', '-p'));
  return f;
}

const PRE = `(async()=>{const r={href:location.href,origin:location.origin,isSecureContext:window.isSecureContext,
 mediaDevices:typeof navigator.mediaDevices,getUserMedia:typeof navigator.mediaDevices?.getUserMedia};
 try{r.perm=(await navigator.permissions.query({name:'microphone'})).state}catch(e){r.perm='n/a:'+e.name}
 return r})()`;
const GUM = `(async()=>{if(!navigator.mediaDevices?.getUserMedia)return{ok:false,name:'TypeError',
 message:'navigator.mediaDevices is '+typeof navigator.mediaDevices};const t0=performance.now();
 try{const s=await navigator.mediaDevices.getUserMedia({audio:true});const tr=s.getAudioTracks()[0];
  await new Promise(r=>setTimeout(r,1500));
  const o={ok:true,ms:Math.round(performance.now()-t0),label:tr.label,readyState:tr.readyState,muted:tr.muted,
   sampleRate:tr.getSettings().sampleRate};tr.stop();return o}
 catch(e){return{ok:false,ms:Math.round(performance.now()-t0),name:e.name,message:e.message}}})()`;

const target = await pageTarget();
const cdp = await Cdp.open(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const results = [];
for (const o of origins) {
  log(`origin ${o.id}: ${o.url}`);
  const r = { id: o.id, url: o.url };
  const loaded = cdp.waitEvent('Page.loadEventFired', 20000);
  const nav = await cdp.send('Page.navigate', { url: o.url });
  r.navError = nav.result?.errorText || null;
  r.loaded = !!(await loaded);
  await sleep(800);
  r.pre = await cdp.eval(PRE, 10000);
  const bar = uiNodes().find((n) => /url_bar|location_bar_status|url_action/.test(n.id) && n.text);
  r.addressBar = bar ? bar.text : null;

  const gum = cdp.eval(GUM, 30000);
  let prompt = null;
  if (r.pre && r.pre.getUserMedia === 'function') {
    for (let i = 0; i < 12 && !prompt; i++) {
      const nodes = uiNodes();
      const btn = nodes.find((n) => n.cls.includes('Button') && ALLOW.test(n.text.trim()) && n.bounds);
      if (btn) {
        prompt = {
          buttons: nodes.filter((n) => n.cls.includes('Button') && n.text).map((n) => n.text),
          text: nodes.filter((n) => n.cls.includes('TextView') && n.text).map((n) => n.text).slice(0, 6),
          tapped: btn.text,
        };
        r.promptShot = shot(`chrome-mic-${o.id}-prompt.png`);
        const [x1, y1, x2, y2] = btn.bounds;
        sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
        break;
      }
      await sleep(700);
    }
  }
  r.prompt = prompt;
  r.gum = await gum;
  r.post = await cdp.eval(PRE, 10000);
  r.shot = shot(`chrome-mic-${o.id}-after.png`);
  results.push(r);
}

try { adb('forward', '--remove', `tcp:${fport}`); } catch {}
try { adb('reverse', '--remove', `tcp:${lport}`); } catch {}
sh(`am force-stop ${CHROME}`);
server.close();

let out = JSON.stringify({ chrome: chromeVersion, android, device: 'AVD (emulator, virtual mic = zeros)', results }, null, 1);
if (REDACT) out = out.split(REDACT).join('<tailnet-host>');
console.log(out);
process.exit(0);

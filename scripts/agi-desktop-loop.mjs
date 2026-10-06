import { chromium } from '@playwright/test';
import fs from 'node:fs';

const SHOTS = '/tmp/opencode/agi-loop/desktop';
fs.mkdirSync(SHOTS, { recursive: true });
const report = { startedAt: new Date().toISOString(), steps: {}, timeline: [] };
const step = async (l, fn) => {
  const t0 = Date.now();
  try { await fn(); report.steps[l] = { ok: true, ms: Date.now() - t0 }; console.log(`PASS ${l} ${Date.now()-t0}ms`); }
  catch (e) { report.steps[l] = { ok: false, error: String(e).slice(0, 250) }; console.log(`FAIL ${l}: ${String(e).slice(0, 200)}`); }
};

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
await ctx.addInitScript(() => {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (!c || !c.audio) return orig(c);
    const ac = new AudioContext();
    const buf = await ac.decodeAudioData(await (await fetch('/user-agi.wav')).arrayBuffer());
    const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
    const dst = ac.createMediaStreamDestination(); src.connect(dst); src.start();
    return dst.stream;
  };
});
const page = await ctx.newPage();

await step('A1-tree', async () => {
  await page.goto('http://127.0.0.1:8090/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2000);
  fs.writeFileSync(`${SHOTS}/1-tree.png`, await page.screenshot());
});
await step('A2-click-tree-onboarding', async () => {
  await page.locator('svg').first().click({ timeout: 8000 }).catch(() => page.mouse.click(195, 420));
  await page.waitForTimeout(8000);
  fs.writeFileSync(`${SHOTS}/2-onboarding.png`, await page.screenshot());
});
await step('A3-voice-exchange', async () => {
  await page.waitForTimeout(25000);
  fs.writeFileSync(`${SHOTS}/3-exchange.png`, await page.screenshot());
});
await step('B1-main', async () => {
  await page.evaluate(async () => {
    await fetch('/api/onboard', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'done', from: '/session/onboarding', prefs: { voice: 'woman', style: 'short' } }) });
  }).catch(() => {});
  await page.goto('http://127.0.0.1:8090/session/main', { timeout: 30000 });
  await page.waitForTimeout(2500);
});
await step('B2-handsfree-qa', async () => {
  const free = await page.locator('[data-testid="free-strip"]').first().isVisible().catch(() => false);
  if (!free) await page.click('[data-testid="composer-mic"]');
  await page.waitForTimeout(3000);
  const t0 = Date.now();
  let last = '';
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    let txt = '';
    try { txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim()); } catch {}
    if (txt && txt !== last) { report.timeline.push({ t: Date.now() - t0, text: txt.slice(0, 900) }); last = txt; }
  }
  fs.writeFileSync(`${SHOTS}/4-after.png`, await page.screenshot());
});
report.transcript = await page.evaluate(async () => await (await fetch('/api/session/main/messages')).json()).catch(e => String(e).slice(0, 120));
fs.writeFileSync(`${SHOTS}/desktop-report.json`, JSON.stringify(report, null, 2));
console.log('DESKTOP LOOP DONE, timeline:', report.timeline.length);
process.exit(0);

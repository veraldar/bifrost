import { _android as android } from 'playwright';
import fs from 'node:fs';

const SHOTS = process.argv[2] || '/tmp/android-lab-shots';
const PWA_URL = process.env.PWA_URL || 'http://localhost:8080';
const NAME = `android-lab-${Date.now().toString(36)}`;
const report = { startedAt: new Date().toISOString(), pwaUrl: PWA_URL, steps: {}, install: {}, name: NAME };

const step = async (label, fn) => {
  const t0 = Date.now();
  try {
    const out = await fn();
    report.steps[label] = { ok: true, ms: Date.now() - t0, ...(out || {}) };
    console.log(`PASS ${label} (${Date.now() - t0}ms)`);
  } catch (e) {
    report.steps[label] = { ok: false, ms: Date.now() - t0, error: String(e).slice(0, 500) };
    console.log(`FAIL ${label}: ${String(e).slice(0, 300)}`);
    throw e;
  }
};

const shot = async (page, file) => {
  const png = await device.screenshot();
  fs.writeFileSync(`${SHOTS}/${file}`, png);
};

android.setDefaultTimeout(60_000);
const devices = await android.devices();
if (!devices.length) { console.log('FAIL no adb device'); process.exit(1); }
const device = devices[0];
report.device = { model: typeof device.model === 'function' ? device.model() : device.model, serial: typeof device.serial === 'function' ? device.serial() : device.serial };
console.log('device:', device.model, device.serial);

await device.shell('settings put global window_animation_scale 0');
await device.shell('settings put global transition_animation_scale 0');

const context = await device.launchBrowser({
  pkg: 'com.android.chrome',
  args: ['--no-first-run', '--no-default-browser-check'],
});
await new Promise((r) => setTimeout(r, 2500));
await device.tap(577, 1742).catch(() => {});
await new Promise((r) => setTimeout(r, 1000));
context.setDefaultTimeout(60_000);
await context.addInitScript(() => {
  window.__lab = window.__lab || { bip: 0 };
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__lab.bip++;
    window.__bipEvent = e;
  });
});

const page = await context.newPage();
page.on('pageerror', (e) => { report.consoleErrors = report.consoleErrors || []; report.consoleErrors.push(String(e).slice(0, 200)); });
report.viewport = page.viewportSize();

try {
  await step('open-pwa', async () => {
    await page.goto(PWA_URL, { waitUntil: 'load', timeout: 90_000 });
    await page.getByRole('heading', { name: 'Bifrost' }).waitFor({ timeout: 30_000 });
    await shot(page, '01-home.png');
  });

  await step('install-behavior', async () => {
    const probe = await page.evaluate(async () => {
      const link = document.querySelector('link[rel=manifest]');
      const manifestUrl = link ? new URL(link.href, location.href).href : null;
      let manifestOk = false;
      if (manifestUrl) { try { manifestOk = (await fetch(manifestUrl)).ok; } catch {} }
      const sw = navigator.serviceWorker
        ? (await navigator.serviceWorker.getRegistration()) !== undefined
        : false;
      return {
        manifestUrl,
        manifestOk,
        serviceWorkerApi: !!navigator.serviceWorker,
        swRegistered: sw,
        displayMode: matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
        secureContext: isSecureContext,
        beforeInstallPrompt: window.__lab.bip,
        manifest: link
          ? await fetch(manifestUrl).then((r) => r.json()).then((m) => ({ name: m.name, display: m.display, icons: (m.icons || []).map((i) => i.sizes) })).catch(() => null)
          : null,
      };
    });
    Object.assign(report.install, probe);
    await page.waitForTimeout(4000);
    report.install.beforeInstallPromptAfterWait = await page.evaluate(() => window.__lab.bip);
    let promptOutcome = 'not-fired';
    try {
      promptOutcome = await page.evaluate(async () => {
        if (!window.__bipEvent) return 'not-fired';
        const choice = window.__bipEvent.prompt();
        const r = await Promise.race([choice, new Promise((res) => setTimeout(() => res('no-native-tap'), 8000))]);
        return r && r.outcome ? r.outcome : String(r);
      });
    } catch (e) { promptOutcome = 'error:' + String(e).slice(0, 120); }
    report.install.installPromptOutcome = promptOutcome;
    await shot(page, '02-install-probe.png');
  });

  await step('create-session', async () => {
    await page.getByRole('button', { name: 'new session' }).click();
    await page.getByPlaceholder('session name…').fill(NAME);
    await page.getByRole('button', { name: 'create & open' }).click();
    await page.waitForURL(new RegExp(`/session/${NAME}`), { timeout: 30_000 });
    await page.getByText('empty session').waitFor({ timeout: 30_000 });
    await shot(page, '03-session-empty.png');
  });

  await step('text-send', async () => {
    await page.getByPlaceholder('message…').fill('Reply with exactly: pong');
    const send = page.getByRole('button', { name: 'send', exact: true });
    for (let i = 0; i < 150; i++) {
      if (await send.isEnabled().catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!(await send.isEnabled())) throw new Error('send still disabled after 150s (composer wedged by unreachable LiveKit)');
    report.install.sendPointerIntercept = null;
    try {
      await send.click({ timeout: 5000 });
    } catch {
      report.install.sendPointerIntercept =
        'transcript scroll container intercepts pointer events at send button center at this viewport (finding, see docs); force-click used';
      await send.click({ force: true });
    }
    await page.getByText('(you)').first().waitFor({ timeout: 20_000 });
    await shot(page, '04-sent.png');
    report.install.composerSelfHealMs = undefined;
  });

  await step('text-roundtrip', async () => {
    try {
      await page.getByText('(agent').first().waitFor({ timeout: 120_000 });
    } catch {
      report.install.sseLiveness = 'live page did not render the reply in 120s; reloaded the session (consumer recovery) — reply renders from history (finding: matches open wedge-fix claim)';
      await page.reload({ waitUntil: 'load' });
      await page.getByPlaceholder('message…').waitFor({ timeout: 60_000 });
    }
    await page.getByText('(agent').first().waitFor({ timeout: 900_000 });
    await page.getByText('pong', { exact: true }).first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2000);
    const busy = await page.getByText('working…').count();
    if (busy !== 0) throw new Error('still busy after reply');
    await shot(page, '05-reply.png');
  });

  await step('device-screen', async () => {
    const png = await device.screenshot();
    fs.writeFileSync(`${SHOTS}/06-device-screen.png`, png);
  });
} catch (e) {
  try { await shot(page, '99-failure.png'); } catch {}
  report.fatal = String(e).slice(0, 500);
}

report.finishedAt = new Date().toISOString();
report.verdict = Object.values(report.steps).every((s) => s.ok) ? 'PASS' : 'FAIL';
fs.writeFileSync(`${SHOTS}/report.json`, JSON.stringify(report, null, 2));
console.log('VERDICT', report.verdict);
await context.close();
process.exit(report.verdict === 'PASS' ? 0 : 1);

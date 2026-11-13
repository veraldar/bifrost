// Rebuild evidence: screenshot every screen × every theme against a local
// production server (never the live :8080). Usage:
//   node scripts/rebuild-shots.mjs <tag> [baseURL] [sessionId]
// → ../artifacts/rebuild/<tag>-<theme>-<screen>.png
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const tag = process.argv[2] || 'shot';
const base = process.argv[3] || 'http://127.0.0.1:3311';
const sid = process.argv[4] || 'ses_f073b9de5ffeGbKtcXvEuKAjxj';
const out = path.join(process.cwd(), '..', 'artifacts', 'rebuild');
fs.mkdirSync(out, { recursive: true });

const sess = await (await fetch(`${base}/api/session`)).json();
const s = sess.find((x) => x.id === sid);
const slug = (s?.title || sid)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const screens = [
  ['home', '/'],
  ['session', `/session/${slug}?id=${sid}`],
  ['session-settings', `/session/${slug}/settings?id=${sid}`],
  ['settings', '/settings'],
  ['artifacts', '/artifacts'],
];

const browser = await chromium.launch();
for (const theme of ['aether', 'terminus', 'drift']) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => {
    localStorage.setItem('theme', t);
    localStorage.setItem('oz-read-init', '1');
    localStorage.setItem('oz-artifacts-seen-init', '1');
  }, theme);
  const page = await ctx.newPage();
  for (const [name, url] of screens) {
    await page.goto(base + url, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, `${tag}-${theme}-${name}.png`) });
  }
  await ctx.close();
}
await browser.close();
console.log('shots →', out);

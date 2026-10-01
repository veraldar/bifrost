// veraldar.org evidence: 3 worlds × full page, plus interactive checks
// (theme switch flips data-theme + tokens instantly and persists; the tree
// wakes once on first sight; holding it turns it amber "heard"; the
// miniature mic walks heard → working → idle). Usage:
//   node scripts/veraldar-shots.mjs [baseURL]
import { chromium } from '@playwright/test';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:3312';
const out = path.join(process.cwd(), '..', 'artifacts', 'rebuild');
const browser = await chromium.launch();
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

for (const theme of ['aether', 'terminus', 'drift']) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => localStorage.setItem('veraldar-theme', t), theme);
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3200); // let the first-sight wake pass finish
  await page.screenshot({ path: path.join(out, `veraldar-${theme}.png`) });
  await page.screenshot({ path: path.join(out, `veraldar-${theme}-full.png`), fullPage: true });
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === theme, `${theme}: persisted world applied before paint`);
  await ctx.close();
}

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(base + '/', { waitUntil: 'networkidle' });
// first sight → one wake pulse up the trunk, then stillness
await page.waitForFunction(() => document.getElementById('tree').classList.contains('wake'), null, { timeout: 4000 }).then(
  () => ok(true, 'tree wakes on first sight'), () => ok(false, 'tree wakes on first sight'));
await page.waitForTimeout(2800);
ok(!(await page.evaluate(() => document.getElementById('tree').classList.contains('wake'))), 'tree falls still after the pulse');
const anims = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.('#tree')).length);
ok(anims === 0, `tree at rest runs no animations (${anims})`);
// world switch: one attribute, tokens follow, instant
const t0 = Date.now();
await page.getByRole('button', { name: 'terminus' }).click();
const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--oz-bg').trim());
ok(bg === '#100c14', `terminus tokens applied (${bg}) in ${Date.now() - t0}ms`);
ok((await page.evaluate(() => localStorage.getItem('veraldar-theme'))) === 'terminus', 'world persisted');
// hold the tree → heard (amber), release → dim
const box = await page.locator('#tree').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(900);
ok((await page.locator('#cap').textContent()) === 'heard', 'hold → heard');
await page.screenshot({ path: path.join(out, 'veraldar-terminus-tree-held.png') });
await page.mouse.up();
ok((await page.locator('#cap').textContent()) === 'hold to be heard', 'release → dim');
// miniature mic: heard → working → idle
await page.locator('#m-mic').scrollIntoViewIfNeeded();
const mb = await page.locator('#m-mic').boundingBox();
await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
await page.mouse.down();
await page.waitForTimeout(300);
ok((await page.locator('#m-rail').getAttribute('data-s')) === 'heard', 'mini mic held → rail heard');
await page.screenshot({ path: path.join(out, 'veraldar-terminus-mic-held.png') });
await page.mouse.up();
ok((await page.locator('#m-rail').getAttribute('data-s')) === 'working', 'release → rail working');
await page.waitForTimeout(2900);
ok((await page.locator('#m-rail').getAttribute('data-s')) === 'idle', 'reply lands → idle');
// public contract still served
for (const f of ['theme.json', 'tokens.css', 'realms.json', 'icon.svg', 'theme-assets/backdrop.svg', 'world-tree.html'])
  ok((await page.request.get(base + '/' + f)).ok(), `serves ${f}`);
await page.goto(base + '/world-tree.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
ok((await page.locator('#verdict').textContent()).includes('leads'), 'world-tree page renders its verdict');
await page.screenshot({ path: path.join(out, 'veraldar-world-tree-page.png') });
await browser.close();

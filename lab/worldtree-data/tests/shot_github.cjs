// Screenshot the rings section with the GitHub dashed lines: node tests/shot_github.cjs <url> <out.png> [width]; prints {info, errs}
const { chromium } = require('/home/dweeb_xyz/Work/bifrost/pwa/node_modules/playwright');
(async () => {
  const [url, out, w] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +w || 1200, height: 900 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) });
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForSelector('#rings:not([hidden]) #tchart .gh', { timeout: 15000 });
  const el = await p.$('#rings');
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  const info = await p.evaluate(() => ({ gh: document.querySelectorAll('#tchart .gh').length, labels: [...document.querySelectorAll('#tchart .ghl')].map(t => t.textContent), read: document.querySelector('#tread').innerText.split('\n').slice(-1)[0], key: document.querySelector('#tghk').innerText }));
  await el.screenshot({ path: out });
  console.log(JSON.stringify({ info, errs }));
  await b.close();
})();

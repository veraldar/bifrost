// Screenshot the AI EVOLUTION tab (M9 tabs, hash-routed): node tests/shot_github.cjs <url> <out.png> [width]; prints {info, errs}
const { chromium } = require('/home/dweeb_xyz/Work/bifrost/pwa/node_modules/playwright');
(async () => {
  const [url, out, w] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +w || 1200, height: 900 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) });
  await p.goto(`${url}#evolution`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2600); // tree growth + lazy panel paint
  await p.waitForSelector('#tp-evolution:not([hidden]) #erel .bar', { timeout: 15000 });
  const el = await p.$('#evo');
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  const info = await p.evaluate(() => ({
    selected: document.querySelector('[role=tab][aria-selected=true]').textContent,
    rel: document.querySelectorAll('#erel .bar').length,
    com: document.querySelectorAll('#ecom .bar, #ecom path, #ecom polyline').length,
    stars: document.querySelectorAll('#estar tbody tr').length,
    call: [...document.querySelectorAll('#evoCall b')].map(x => x.textContent),
    label: (document.querySelector('#tp-evolution h2') || {}).textContent || ''
  }));
  await el.screenshot({ path: out });
  console.log(JSON.stringify({ info, errs }));
  await b.close();
})();

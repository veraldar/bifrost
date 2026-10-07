// Screenshot the AI EVOLUTION tab (M9 tabs): node tests/shot_github.cjs <url> <out.png> [width]; prints {info, errs}
const { chromium } = require('/home/dweeb_xyz/Work/bifrost/pwa/node_modules/playwright');
(async () => {
  const [url, out, w] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +w || 1200, height: 900 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) });
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.click('#tab-evolution');
  await p.waitForSelector('#tp-evolution:not([hidden]) #erel svg path, #tp-evolution:not([hidden]) #erel rect, #tp-evolution:not([hidden]) #erel polyline', { timeout: 15000 });
  const el = await p.$('#evo');
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  const info = await p.evaluate(() => ({
    rel: document.querySelectorAll('#erel path, #erel rect, #erel polyline').length,
    com: document.querySelectorAll('#ecom path, #ecom rect, #ecom polyline').length,
    stars: document.querySelectorAll('#estar tr, #estar .srow, #estar li').length,
    notes: (document.querySelector('#enotes') || {}).innerText || '',
    label: (document.querySelector('#tp-evolution h2') || {}).textContent || ''
  }));
  await el.screenshot({ path: out });
  console.log(JSON.stringify({ info, errs }));
  await b.close();
})();

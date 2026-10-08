// Screenshot the AI EVOLUTION tab's TOOLS block (M10): node tests/shot_tools.cjs <url> <out.png> [width]; prints {info, errs}
const { chromium } = require('/home/dweeb_xyz/Work/bifrost/pwa/node_modules/playwright');
(async () => {
  const [url, out, w] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +w || 1200, height: 900 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) });
  await p.goto(`${url}#evolution`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2600); // tree growth + lazy panel paint
  await p.waitForSelector('#tp-evolution:not([hidden]) #etools:not([hidden]) #etrep polyline', { timeout: 15000 });
  await p.addStyleTag({ content: '.top{position:absolute!important}' }); // the fixed header would be stitched into a tall element shot
  const el = await p.$('#etools');
  await el.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  const info = await p.evaluate(() => ({
    selected: document.querySelector('[role=tab][aria-selected=true]').textContent,
    h2: (document.querySelector('#etH') || {}).textContent || '',
    rep: document.querySelectorAll('#etrep polyline').length,
    lean: document.querySelectorAll('#elean polyline').length,
    math: document.querySelectorAll('#emath polyline').length,
    read: (document.querySelector('#etrRead') || {}).textContent || '',
    call: [...document.querySelectorAll('#etCall b')].map(x => x.textContent),
    stars: document.querySelectorAll('#etstar tbody tr').length,
    thesis: (document.querySelector('#etnotes li') || {}).textContent || '',
    dataLinks: [...document.querySelectorAll('#etnotes li:first-child a')].map(a => a.getAttribute('href')),
    prov: (document.querySelector('#etrProv') || {}).textContent || '',
    map: (document.querySelector('#etMap') || {}).textContent || '',
    modelCharts: document.querySelectorAll('#erel .bar').length
  }));
  await el.screenshot({ path: out });
  console.log(JSON.stringify({ info, errs }));
  await b.close();
})();

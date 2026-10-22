#!/usr/bin/env node
/**
 * naming-audit — where does a first-timer meet each name on veraldar.org?
 *
 *   node scripts/naming-audit.mjs [URL]   (default http://127.0.0.1:8777/ — the
 *   site's working copy, the same server playwright.site.config.ts starts)
 *
 * Walks the page's VISIBLE text in reading order on a phone viewport (360×780,
 * what a first-timer sees scrolling down — the door and the films are closed),
 * and prints, for every name in the cosmology, its first appearance: the
 * section, the y in px, and the words around it. Then the count a first-timer
 * holds before the page has said what the product does ("talk … phone …
 * computer"). FILM-NAMING 10-22: the before/after referee for the naming ladder.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../pwa/package.json'));
const { chromium } = require('@playwright/test');

const URL_ = process.argv[2] || 'http://127.0.0.1:8777/';
const TERMS = ['veraldar', 'world-tree', 'bifrost', 'yggdrasil', 'tree', 'root', 'trunk', 'branch',
  'brain', 'private line', 'midgard', 'asgard', 'far vision', 'tailnet', 'tailscale'];

// inside lk-yggdrasil's hardening (no JIT): node --jitless + PW_JITLESS=1
const browser = await chromium.launch(process.env.PW_JITLESS ? { args: ['--js-flags=--jitless', '--no-sandbox'] } : {});
const page = await browser.newPage({ viewport: { width: 360, height: 780 }, serviceWorkers: 'block' });
await page.goto(URL_, { waitUntil: 'networkidle' });
const hits = await page.evaluate((terms) => {
  const out = [];
  const seen = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n, i = 0;
  while ((n = w.nextNode())) {
    const el = n.parentElement;
    if (!el || el.closest('script,style,[hidden],#door,#film')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    const text = n.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    i++;
    const sec = el.closest('section,.hero,header,footer,.wtline');
    const where = sec ? (sec.id || sec.className.split(' ')[0] || sec.tagName.toLowerCase()) : 'body';
    const y = Math.round(r.top + scrollY);
    const low = text.toLowerCase();
    if (!seen.has('#product') && /talk/.test(low) && /phone/.test(low) && /computer/.test(low))
      { seen.add('#product'); out.push({ term: '#product', where, y, i, text }); }
    for (const t of terms) {
      if (seen.has(t)) continue;
      const re = new RegExp('\\b' + t.replace('-', '\\-') + 's?\\b', 'i');
      if (re.test(text)) { seen.add(t); out.push({ term: t, where, y, i, text }); }
    }
  }
  return out;
}, TERMS);
await browser.close();

let before = 0, said = false;
console.log(`naming audit — ${URL_} (phone 360×780, visible text, reading order)\n`);
for (const h of hits) {
  if (h.term === '#product') said = true; else if (!said) before++;
  const tag = h.term === '#product' ? '» WHAT IT DOES' : h.term;
  console.log(`${String(h.y).padStart(5)}px  ${h.y < 780 ? 'fold' : '    '}  ${tag.padEnd(14)} ${h.where.padEnd(10)} ${h.text.slice(0, 90)}`);
}
console.log(`\nnames met before the page says what it does: ${said ? before : `${before} (never said)`}`);
console.log(`never on the page: ${TERMS.filter((t) => !hits.some((h) => h.term === t)).join(', ') || '—'}`);

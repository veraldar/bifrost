// M8 honesty checks on the rendered page: node tests/shot_honesty.cjs <url> [out.png] — prints {checks, detail, errs}
// Reads what a visitor reads (default lens, then STRICT AI, the rings, AI EVOLUTION, SOURCES MAP); every check is a claim
// the M8 review made about the page (docs/worldtree/honesty-review.md).
const { chromium } = require('/home/dweeb_xyz/Work/bifrost/pwa/node_modules/playwright');
(async () => {
  const [url, out] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 1 });
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) });
  const sep = url.includes('?') ? '&' : '?';
  await p.goto(`${url}${sep}lens=balanced`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const T = s => p.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : '' }, s);
  const d = {};
  d.status = await T('#status');
  d.hero = await T('#p0');
  d.feedsH = await T('#feedsH');
  d.feeds = await T('#feedList');
  d.srcH = await T('#srcH');
  d.dials = await p.evaluate(() => [...document.querySelectorAll('#dgrid .dial')].map(f => f.dataset.k + ' ' + f.querySelector('.dv').textContent));
  d.essay = await T('#essay');
  d.outcomes = await T('#tp-outcomes');
  d.lensbar = await T('#lens');
  d.rings = await T('#tchart');
  d.tnote = await T('#rings .tnote');
  await p.focus('#tchart'); await p.keyboard.press('Home'); await p.waitForTimeout(200);
  d.ring2015 = await T('#tread');
  // the offline fallback embedded in the page: a measured realms.json, never the retired news-pipeline numbers
  d.snap = await p.evaluate(async () => { const h = await (await fetch(location.pathname, { cache: 'no-store' })).text(); const m = h.match(/const SNAP=(\{.*\});\n/); if (!m) return { found: false };
    const j = JSON.parse(m[1]); return { found: true, method: j.method_version || null, modes: !!(j.modes && j.modes.strict), news: /items/.test(j.window || '') || !!j.collection } });
  // STRICT AI: the numbers must move (they are modes.strict now, not a relabel of weights)
  await p.click('#lens button[data-lv="strict"]'); await p.waitForTimeout(1800);
  d.dialsStrict = await p.evaluate(() => [...document.querySelectorAll('#dgrid .dial')].map(f => f.dataset.k + ' ' + f.querySelector('.dv').textContent));
  d.heroStrict = await T('#p0');
  d.dialLedeStrict = await T('#dialLede');
  await p.click('#lens button[data-lv="balanced"]'); await p.waitForTimeout(600);
  // AI EVOLUTION
  await p.evaluate(() => { location.hash = 'evolution' }); await p.waitForTimeout(1500);
  d.evoCall = await T('#evoCall'); d.evoMap = await T('#evoMap'); d.etCall = await T('#etCall'); d.etMap = await T('#etMap');
  // SOURCES MAP
  await p.evaluate(() => { location.hash = 'sources' }); await p.waitForTimeout(1500);
  d.atlas = await T('#atlas .rhead p'); d.acap = await T('#acap');
  if (out) { await p.evaluate(() => { location.hash = 'outcomes' }); await p.waitForTimeout(800); await p.screenshot({ path: out }) }
  const m = /Feeds · (\d+) of (\d+)/.exec(d.feedsH) || [];
  const checks = {
    hero_not_probability: /not a probability/.test(d.hero) && /14\.3%/.test(d.hero),
    hero_names_strict_leader: /STRICT AI/.test(d.hero),
    all_indicators_listed: !!m[1] && m[1] === m[2],
    excluded_visible: /excluded:/.test(d.feeds),
    sources_are_series: /series used/.test(d.srcH) && !/items/.test(d.srcH),
    strict_moves_numbers: d.dials.join() !== d.dialsStrict.join(),
    strict_names_left_out: /Left out:/.test(d.dialLedeStrict),
    no_news_words_on_outcomes: !/loudest headline|headlines? names? no AI|passed the AI gate|AI-gated|hurricane|items tallied|\d items\b/i.test(d.outcomes + d.lensbar),
    essay_measured: /re-read it for honesty/.test(d.essay) && /not the chance/.test(d.essay),
    rings_even_line: /even 14\.3/.test(d.rings),
    rings_gap_note: /gap = no indicator yet/.test(d.tnote),
    ring_2015_no_data: /no data/.test(d.ring2015) && /would not publish/.test(d.ring2015),
    snap_is_measured: d.snap.found && !!d.snap.method && d.snap.method >= '0.6.0' && d.snap.modes && !d.snap.news,
    evo_like_for_like: /the same repos/.test(d.evoCall) && /cut by bots/.test(d.evoCall),
    tools_platform: /GitHub itself/.test(d.etCall) && /share of all new GitHub repos/.test(d.etMap),
    atlas_no_ai_claim: /None of these country indicators measures AI/.test(d.atlas) && /indicator/.test(d.acap)
  };
  console.log(JSON.stringify({ checks, detail: d, errs }));
  await b.close();
})();

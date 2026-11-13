#!/usr/bin/env node
/** root-coord tree fixture for e2e/tree.spec.ts: writes a coordinator tree
 *  into a yggdrasil data dir — cards can't be set through the brain's API, so
 *  the sessions go in as files, BEFORE the brain starts (it loads them once).
 *
 *    node e2e/tree-seed.mjs <YGG_DATA_DIR>
 *
 *  [MAIN] ─┬─ Static recipe site (lead, working)
 *          │    ├─ Recipe pages (build, done)
 *          │    │    └─ Recipe photos (research, blocked: needs an answer)
 *          │    ├─ Search box (build, working)
 *          │    └─ Old layout draft (closed)
 *          ├─ Habit tracker CLI (build, done)
 *          ├─ Wordfreq CLI (build, failed)
 *          └─ Notes API stdlib (closed)
 *  garden plan ── seed list           (no cards: a hand-made pair)
 *
 *  MAIN's transcript carries route tags (`→ <title>`), one naming no session,
 *  one inside inline code, and a coordinator autoReply. Never point it at a
 *  real brain's data dir. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: tree-seed.mjs <YGG_DATA_DIR>');
  process.exit(2);
}
mkdirSync(path.join(dir, 'session'), { recursive: true });

const now = Date.now();
const MODEL = { id: 'glm-5.3-flash', providerID: 'yggdrasil', variant: 'off' };
let n = 0;
const mid = () => `msg_t2e${String(++n).padStart(4, '0')}`;

function msg(sid, role, text, at, meta) {
  const id = mid();
  const info = { id, role, sessionID: sid, time: { created: at } };
  if (role === 'assistant') info.time.completed = at + 900;
  if (meta) info.meta = meta;
  return { info, parts: [{ id: `prt_${id.slice(4)}`, messageID: id, sessionID: sid, type: 'text', text }] };
}

function write(info, messages) {
  writeFileSync(path.join(dir, 'session', `${info.id}.json`), JSON.stringify({ info, messages }, null, 2));
}

function managed(id, title, parentID, agent, card, ago, extra = {}) {
  const at = now - ago * 60_000;
  const info = {
    id,
    title,
    parentID,
    agent,
    model: MODEL,
    time: { created: at - 600_000, updated: at },
    card: { topic: title, brief: `work on ${title}`, created: at - 600_000, updated: at, needs: '', ...card },
    ...extra,
  };
  write(info, [
    msg(id, 'user', `Brief: ${title}.`, at - 600_000, { origin: parentID }),
    msg(id, 'assistant', `${title}: ${card.headline || 'on it'}.`, at - 300_000),
  ]);
}

const MAIN = 'ses_t2emain';
const A = 'ses_t2erecipesite';
const A1 = 'ses_t2erecipepages';
const A1A = 'ses_t2erecipephotos';
const A2 = 'ses_t2esearchbox';
const A3 = 'ses_t2eoldlayout';

const m0 = now - 40 * 60_000;
write({ id: MAIN, title: '[MAIN]', model: MODEL, time: { created: m0, updated: now - 60_000 }, card: { wakes: 2 } }, [
  msg(MAIN, 'user', 'need a static recipe site with a search box, and a habit tracker cli', m0),
  msg(
    MAIN,
    'assistant',
    '→ Static recipe site: lead session started — it splits the pages and the search box. ' +
      'Also → Habit tracker CLI (folder `habits`) and → New build session for the notes, later.',
    m0 + 1000
  ),
  msg(MAIN, 'user', '[inbox] Reports from your sessions since the user last heard from you: …', now - 2 * 60_000, {
    auto: true,
    internal: true,
  }),
  msg(
    MAIN,
    'assistant',
    'Habit tracker is done — 35 tests pass. → Recipe photos needs your answer on the photo licence. ' +
      'Literal, not a link: `→ Static recipe site`.',
    now - 2 * 60_000 + 1000,
    { autoReply: true }
  ),
]);

managed(A, 'Static recipe site', MAIN, 'lead', {
  status: 'working',
  headline: 'index + 3 recipe pages drafted; search box in progress',
  summary:
    'Split into Recipe pages (done) and Search box (working). Recipe photos waits on the licence question. ' +
    'Next: wire the search box into the index, then a last pass over the shared stylesheet and a link check.',
}, 3);
managed(A1, 'Recipe pages', A, 'build', {
  status: 'done',
  headline: '3 recipe pages + shared stylesheet written',
  summary: 'pancakes.html, curry.html, soup.html share style.css; all linked from index.html.',
}, 9);
managed(A1A, 'Recipe photos', A1, 'research', {
  status: 'blocked',
  headline: 'found 9 candidate photos',
  needs: 'Which photo licence is OK — CC-BY or only CC0?',
  summary: 'Nine candidates, five CC-BY and four CC0. Waiting on the licence choice.',
}, 5);
managed(A2, 'Search box', A, 'build', {
  status: 'working',
  headline: 'filter by name works; writing tests',
}, 1);
managed(A3, 'Old layout draft', A, 'build', {
  status: 'archived',
  headline: 'closed: superseded by Recipe pages',
}, 30, { archived: true });
managed('ses_t2ehabits', 'Habit tracker CLI', MAIN, 'build', {
  status: 'done',
  headline: '35 tests pass; export command added',
}, 12);
managed('ses_t2ewordfreq', 'Wordfreq CLI', MAIN, 'build', {
  status: 'failed',
  headline: 'pytest crashed: missing fixture file',
}, 20);
managed('ses_t2enotesapi', 'Notes API stdlib', MAIN, 'build', {
  status: 'archived',
  headline: 'closed: delivered',
}, 35, { archived: true });

// a hand-made pair, no cards: reads exactly as before (collapsed under its pill)
const g0 = now - 90 * 60_000;
write({ id: 'ses_t2egarden', title: 'garden plan', model: MODEL, time: { created: g0, updated: g0 } }, [
  msg('ses_t2egarden', 'user', 'what should I plant in march?', g0),
  msg('ses_t2egarden', 'assistant', 'Peas, spinach and radishes can go out in march.', g0 + 1000),
]);
write(
  { id: 'ses_t2eseeds', title: 'seed list', parentID: 'ses_t2egarden', model: MODEL, time: { created: g0, updated: g0 } },
  [
    msg('ses_t2eseeds', 'user', 'list the seeds', g0),
    msg('ses_t2eseeds', 'assistant', 'Peas, spinach, radishes.', g0 + 1000),
  ]
);

console.log(`tree-seed: 11 sessions → ${path.join(dir, 'session')}`);

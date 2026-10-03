/** Artifact meta engine — ai categories, one-line notes, session attribution.
 *  Sidecar artifacts/.meta.json (covered by the /artifacts/* gitignore):
 *    { cats: string[], items: { [name]: { cat, note, ses, mtime, at } } }
 *  Law: force-set on post (fs watcher + run-end hook + gallery open), re-cat
 *  on demand — all triggers funnel into ONE batched opencode run, gated by a
 *  single-flight lock and a cooldown. No daemon, no queue: one module, one
 *  promise. The agent runs on this box, so artifacts are attributed by
 *  scanning likely sessions for the file's mention — author frozen at first
 *  hit; re-cat never changes ses. */
import { readFile, writeFile, rename, stat } from 'fs/promises';
import path from 'path';
import { ocFetch } from './oc';
import { slugify } from './slug';
import { ARTIFACT_TYPES, ARTIFACTS_DIR, listArtifacts, type ArtifactEntry } from './artifacts';

const META_PATH = path.join(ARTIFACTS_DIR, '.meta.json');
const MAX_CATS = 6;
const BATCH = 10;
const COOLDOWN_MS = 60_000;
const SETTLE_MS = 4_000;

type MetaItem = { cat: string; note?: string; ses?: string; mtime: number; at: number };
type Meta = { cats: string[]; items: Record<string, MetaItem> };

const EMPTY: Meta = { cats: [], items: {} };

export async function readMeta(): Promise<Meta> {
  try {
    const m = JSON.parse(await readFile(META_PATH, 'utf8'));
    return { cats: Array.isArray(m.cats) ? m.cats : [], items: m.items || {} };
  } catch {
    return EMPTY;
  }
}

async function writeMeta(m: Meta) {
  const tmp = META_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(m));
  await rename(tmp, META_PATH);
}

/** Cache-bust token for the gallery: the sidecar's mtime. */
export async function metaVersion(): Promise<string> {
  try {
    return String((await stat(META_PATH)).mtimeMs);
  } catch {
    return '0';
  }
}

/** The categoriser runs tiny prompts — never worth a premium model. Pin the
 *  fastest-looking id on the default provider; fall back to opencode's
 *  default when nothing matches. Cached 10 min. */
let modelCache: { at: number; model: { providerID: string; id: string } | null } | null = null;
async function pickModel() {
  if (modelCache && Date.now() - modelCache.at < 600_000) return modelCache.model;
  let model: { providerID: string; id: string } | null = null;
  try {
    const d = (await ocFetch('/config/providers')) as {
      providers?: { id: string; models?: Record<string, unknown> }[];
    };
    const p = (d.providers || [])[0];
    const fast = Object.keys(p?.models || {}).find(
      (id) => !id.includes('-think-') && /flash|mini|haiku|nano|lite|small|instant/i.test(id)
    );
    if (p && fast) model = { providerID: p.id, id: fast };
  } catch {
    /* providers unreadable — opencode default carries the run */
  }
  modelCache = { at: Date.now(), model };
  return model;
}

/** Positive-evidence authorship: sessions recently updated around the file's
 *  mtime get their transcript scanned for the artifact's mention. Bounded —
 *  three candidates, an 8s overall budget and a 6s per-session race (some
 *  transcripts here carry megabytes of data-urls), first hit wins, null
 *  over wrong. */
async function findAuthor(name: string, mtime: number): Promise<string | undefined> {
  const deadline = Date.now() + 8000;
  try {
    const sessions = (await ocFetch('/session')) as { id: string; time?: { updated?: number } }[];
    const cand = sessions
      .filter((s) => {
        const u = s.time?.updated || 0;
        return u && u > mtime - 900_000 && u <= Date.now();
      })
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      .slice(0, 3);
    for (const s of cand) {
      if (Date.now() > deadline) break;
      const msgs = (await Promise.race([
        ocFetch(`/session/${s.id}/message`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow transcript')), 6000)),
      ]).catch(() => null)) as { parts?: { type: string; text?: string }[] }[] | null;
      if (!msgs) continue;
      const hit = msgs.some((m) =>
        (m.parts || []).some(
          (p) => p.type === 'text' && p.text && (p.text.includes(`artifacts/${name}`) || p.text.includes(name))
        )
      );
      if (hit) return s.id;
    }
  } catch {
    /* attribution is best-effort — null is honest */
  }
  return undefined;
}

const EXCERPT_TYPES = new Set(
  Object.entries(ARTIFACT_TYPES)
    .filter(([, t]) => t.startsWith('text/') || t === 'application/json')
    .map(([ext]) => ext)
);

function excerptFor(f: ArtifactEntry): string {
  if (!EXCERPT_TYPES.has(path.extname(f.name).toLowerCase()) || f.size > 400_000)
    return `- ${f.name} (${f.type}, ${Math.round(f.size / 1024)}kb)`;
  return '';
}

let running: Promise<number> | null = null;
let lastRun = 0;

/** One batched run over the pending set (new or mtime-changed files).
 *  forceNames pins specific files (re-cat); it bypasses the cooldown,
 *  never the single-flight lock. Returns how many items it labelled. */
export function categorizePending(forceNames?: string[]): Promise<number> {
  if (running) return running;
  if (!forceNames && Date.now() - lastRun < COOLDOWN_MS) return Promise.resolve(0);
  running = run(forceNames)
    .catch(() => 0) // a failed run leaves items uncategorized — next trigger retries
    .finally(() => {
      running = null;
      lastRun = Date.now();
    });
  return running;
}

async function run(forceNames?: string[]): Promise<number> {
  const files = await listArtifacts();
  const meta = await readMeta();
  const skip = (n: string) => /^e2e[-_.]/.test(n); // test debris never reaches the model
  let pending = files.filter((f) => {
    if (skip(f.name)) return false;
    const it = meta.items[f.name];
    if (forceNames) return forceNames.includes(f.name);
    return !it || it.mtime !== f.mtime;
  });
  if (!pending.length) return 0;
  // write-settle: a file still being written gets the next trigger instead
  const fresh = new Set<string>();
  for (const f of pending) {
    try {
      if (Date.now() - (await stat(path.join(ARTIFACTS_DIR, f.name))).mtimeMs < SETTLE_MS)
        fresh.add(f.name);
    } catch {
      /* raced a delete */
    }
  }
  pending = pending.filter((f) => !fresh.has(f.name)).slice(0, BATCH);
  if (!pending.length) return 0;

  // attribute + excerpt in parallel-ish (attribution reads transcripts)
  const authors = new Map<string, string | undefined>();
  for (const f of pending) {
    const known = meta.items[f.name]?.ses;
    authors.set(f.name, known ?? (await findAuthor(f.name, f.mtime)));
  }

  const excerpts = (
    await Promise.all(
      pending.map(async (f) => {
        const ex = excerptFor(f);
        if (!ex) return ex;
        try {
          const { readFile: rf } = await import('fs/promises');
          const buf = await rf(path.join(ARTIFACTS_DIR, f.name), 'utf8');
          return `- ${f.name}:\n\`\`\`\n${String(buf).slice(0, 4000)}\n\`\`\``;
        } catch {
          return `- ${f.name} (${f.type})`;
        }
      })
    )
  ).join('\n');

  const catLine = meta.cats.length
    ? `Existing categories: ${meta.cats.join(', ')}. You may propose ONE new category only if the set has fewer than ${MAX_CATS}; otherwise you MUST reuse an existing one.`
    : `Propose up to ${MAX_CATS} categories (fewer if enough) that fit these artifacts as a set.`;
  const prompt = `You label files for a small gallery. ${catLine}
For EACH file reply with a category and a note (max 60 chars, lowercase, what it IS — no fluff).
Reply with ONLY a JSON array, no prose: [{"name":"<file>","cat":"<category>","note":"<one line>"}]
Files:
${excerpts}`;

  const sid = (
    (await ocFetch('/session', {
      method: 'POST',
      body: JSON.stringify({ title: 'artifact-meta' }),
    })) as { id: string }
  ).id;
  const model = await pickModel();
  if (model)
    await ocFetch(`/api/session/${sid}/model`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }).catch(() => {}); // a dead pin must not kill the run — default carries it
  const reply = (await ocFetch(`/session/${sid}/message`, {
    method: 'POST',
    body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
  })) as { parts?: { type: string; text?: string }[] };
  const text = (reply?.parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('\n');
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return 0;
  let verdicts: { name?: string; cat?: string; note?: string }[] = [];
  try {
    verdicts = JSON.parse(m[0]);
  } catch {
    return 0;
  }

  const now = Date.now();
  let added = 0;
  for (const v of verdicts) {
    const f = pending.find((p) => p.name === v.name);
    if (!f || !v.cat) continue;
    if (!meta.cats.includes(v.cat) && meta.cats.length < MAX_CATS) meta.cats.push(v.cat);
    if (!meta.cats.includes(v.cat)) continue; // at cap and the model invented one — drop
    meta.items[f.name] = {
      cat: v.cat,
      note: (v.note || '').slice(0, 60) || undefined,
      ses: authors.get(f.name) || meta.items[f.name]?.ses,
      mtime: f.mtime,
      at: now,
    };
    added++;
  }
  if (added) await writeMeta(meta);
  return added;
}

/** Fire-and-forget trigger for the hooks (gallery open, run end, watcher). */
export function metaTrigger(forceNames?: string[]) {
  void categorizePending(forceNames).then((n) => {
    if (n) console.log(`[meta] categorised ${n} artifact(s)`);
  });
}

/** Force-set on post: the watcher arms the trigger once the dir changes.
 *  Lazy-started by the list route; OC_META_WATCH=0 turns it off (tests). */
let watching = false;
export function startMetaWatcher() {
  if (watching || process.env.OC_META_WATCH === '0') return;
  try {
    let t: ReturnType<typeof setTimeout> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    fs.watch(ARTIFACTS_DIR, () => {
      clearTimeout(t);
      t = setTimeout(() => metaTrigger(), 3000);
    });
    watching = true;
  } catch {
    /* no watcher — gallery-open + run-end triggers still carry it */
  }
}

/** ses → slug for the origin strip's back-link. */
export async function sesSlug(sid: string): Promise<string | null> {
  try {
    const sessions = (await ocFetch('/session')) as { id: string; title?: string }[];
    const hit = sessions.find((s) => s.id === sid);
    return hit ? slugify(hit.title || hit.id) : null;
  } catch {
    return null;
  }
}

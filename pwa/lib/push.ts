/** Web Push (VAPID): the proxy knows exactly when a run finishes (its async
 *  POST resolves on completion), so it can wake the phone even when Chrome
 *  froze the tab — in-page notifications can't do that on Android. */
import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import path from 'path';
import webpush from 'web-push';

const SUBS_FILE = path.join(process.cwd(), '.push-subs.json');
const PUB = process.env.VAPID_PUBLIC_KEY || '';
const PRIV = process.env.VAPID_PRIVATE_KEY || '';

let configured = false;
function ensureConfigured(): boolean {
  if (!PUB || !PRIV) {
    if (!configured) console.warn('[push] VAPID keys missing — push disabled');
    configured = true;
    return false;
  }
  webpush.setVapidDetails('mailto:dweeb@dweeb.xyz', PUB, PRIV);
  return true;
}

type Sub = webpush.PushSubscription;

async function loadSubs(): Promise<Sub[]> {
  try {
    return JSON.parse(await readFile(SUBS_FILE, 'utf8')) as Sub[];
  } catch {
    return [];
  }
}

async function saveSubs(subs: Sub[]): Promise<void> {
  await writeFile(SUBS_FILE, JSON.stringify(subs, null, 1));
}

export function publicKey(): string {
  return PUB;
}

export async function addSub(sub: Sub): Promise<void> {
  if (!sub?.endpoint) return;
  const subs = await loadSubs();
  if (!subs.some((s) => s.endpoint === sub.endpoint)) subs.push(sub);
  await saveSubs(subs);
}

export async function removeSub(endpoint: string): Promise<void> {
  await saveSubs((await loadSubs()).filter((s) => s.endpoint !== endpoint));
}

/** Best-effort broadcast to every device; dead subscriptions are pruned.
 *  Delivery ratio instrumentation (native-app-eval Rung 0): the denominator
 *  lands here as `[push] sent`; the service worker posts `[push] shown` to
 *  /api/diag on display — ratio = shown/sent in pwa/.diag/diag-YYYY-MM-DD.log. */
export async function pushRunDone(slug: string): Promise<void> {
  await broadcast({ slug, body: `reply ready — ${slug}`, tag: `oz-${slug}` }, slug);
}

/** A lane's completion letter (envelope v1, scripts/agi-run.sh): same wire as a
 *  run-done push, no session slug — a tap just focuses the app. Returns the
 *  number of devices reached (0 = no subs / push disabled). */
export async function pushLetter(l: { id: string; from: string; kind: string; body: string }): Promise<number> {
  const first = String(l.body || '').split('\n')[0].slice(0, 140);
  return broadcast(
    { body: `${l.from.split('/').pop()} · ${l.kind} — ${first}`, tag: `letter-${l.id}` },
    `letter:${l.id}`
  );
}

async function broadcast(msg: { slug?: string; body: string; tag: string }, label: string): Promise<number> {
  if (!ensureConfigured()) return 0;
  const subs = await loadSubs();
  if (!subs.length) return 0;
  const payload = JSON.stringify(msg);
  const alive: Sub[] = [];
  let ok = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(s, payload, { TTL: 3600, urgency: 'high' });
        alive.push(s);
        ok += 1;
      } catch (e: any) {
        // 404/410 = subscription expired — drop it
        if (e?.statusCode !== 404 && e?.statusCode !== 410) alive.push(s);
      }
    })
  );
  if (alive.length !== subs.length) await saveSubs(alive);
  try {
    const day = new Date().toISOString().slice(0, 10);
    await mkdir(path.join(process.cwd(), '.diag'), { recursive: true });
    await appendFile(
      path.join(process.cwd(), '.diag', `diag-${day}.log`),
      `${new Date().toISOString()} [push] (server · sent) slug=${label} ok=${ok}/${subs.length} urgency=high\n`
    );
  } catch {
    /* diag is best-effort — never fail the push */
  }
  return ok;
}

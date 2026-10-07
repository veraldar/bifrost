/**
 * POST /api/bridge — machine-to-phone reports (cron jobs, monitors, other
 * agents). Lands the report in a session as a user message (same send path
 * as the phone: live run → proxy queue, else forward) and wakes the phone
 * with a Web Push.
 *
 *   Authorization: Bearer $BRIDGE_TOKEN   (unset token = bridge closed, 401)
 *   body: {source, session?, severity?, title?, message, timestamp}
 *   → 202 {sessionId, slug}
 *
 * session defaults to 'reports'; a slug with no session behind it gets one
 * created (title = slug, so it resolves by slug next time).
 */
import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { ocFetch, resolveId } from '@/lib/oc';
import { bustCache } from '@/lib/oc-cache';
import { forward } from '@/lib/oc-forward';
import { isRunLive } from '@/lib/oc-live';
import { enqueue } from '@/lib/oc-queue';
import { bustSearchResults, bustTranscript } from '@/lib/oc-transcript';
import { ensureWatchdog } from '@/lib/oc-watchdog';
import { pushNotify } from '@/lib/push';
import { slugify } from '@/lib/slug';

export const dynamic = 'force-dynamic';

const DEFAULT_SESSION = 'reports';

function authorized(req: Request): boolean {
  const token = process.env.BRIDGE_TOKEN || '';
  if (!token) return false; // fail closed — never accept "Bearer " or "Bearer undefined"
  const got = req.headers.get('authorization') || '';
  // hash both sides: timingSafeEqual needs equal lengths, and the length
  // itself must not leak through an early return
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(got), h(`Bearer ${token}`));
}

// two reports racing into a missing session must not create it twice
const creating = new Map<string, Promise<string>>();

async function resolveOrCreate(slug: string): Promise<string> {
  try {
    return await resolveId(slug);
  } catch (e) {
    // only "not found" creates — opencode being down must surface, not
    // spawn a session on the next healthy call
    if (!String(e).includes('no session for slug')) throw e;
  }
  let p = creating.get(slug);
  if (!p) {
    p = (async () => {
      const s = await ocFetch('/session', {
        method: 'POST',
        body: JSON.stringify({ title: slug.slice(0, 80) }),
      });
      bustCache();
      return s.id as string;
    })().finally(() => creating.delete(slug));
    creating.set(slug, p);
  }
  return p;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return NextResponse.json({ error: 'body must be a JSON object' }, { status: 400 });
  }

  const source = str(body.source, 80);
  const message = str(body.message, 100_000);
  const severity = str(body.severity, 20);
  const title = str(body.title, 200);
  const ts = body.timestamp;
  const timestamp = typeof ts === 'number' || typeof ts === 'string' ? String(ts).slice(0, 40) : '';
  if (!source || !message || !timestamp) {
    return NextResponse.json(
      { error: 'source, message and timestamp are required' },
      { status: 400 }
    );
  }
  if (body.session !== undefined && typeof body.session !== 'string') {
    return NextResponse.json({ error: 'session must be a string' }, { status: 400 });
  }
  const rawSession = (body.session as string | undefined)?.trim() || DEFAULT_SESSION;
  if (rawSession.includes('..')) {
    return NextResponse.json({ error: "'..' not allowed in session" }, { status: 400 });
  }
  // real ids pass through untouched; anything else is matched as a slug
  const slug = rawSession.startsWith('sess_') ? rawSession : slugify(rawSession);

  try {
    ensureWatchdog(); // keeps the home list's working dot live for this run
    const sid = await resolveOrCreate(slug);

    const head = [`[bridge · ${source}${severity ? ` · ${severity}` : ''}]`, title]
      .filter(Boolean)
      .join(' ');
    const text = `${head}\n\n${message}\n\n— ${timestamp}`;

    // same send path as the phone (messages route, async branch)
    if (isRunLive(sid)) enqueue(sid, { text, images: [], files: [] });
    else forward(sid, slug, { text });
    bustCache();
    bustTranscript(sid);
    bustSearchResults();

    // best-effort — a push failure must not fail a report that already landed
    const preview = `${severity ? `${severity}: ` : ''}${title || message}`.slice(0, 140);
    void pushNotify({ slug, body: `${source} — ${preview}`, tag: `bridge-${slug}` }).catch((e) =>
      console.warn(`[bridge] push failed: ${e}`)
    );

    return NextResponse.json({ sessionId: sid, slug }, { status: 202 });
  } catch (e) {
    console.error(`[bridge] ${source} → ${slug} failed: ${e}`);
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

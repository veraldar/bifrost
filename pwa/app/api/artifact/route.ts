/** GET  /api/artifact → list of everything in bifrost/artifacts/ for the
 *  /artifacts gallery: name, mtime, size, served type. Newest first.
 *    ?meta=1 merges the sidecar (cat, note, ses, slug) — the gallery ask
 *    flow; the home badge polls this route without it and stays cheap.
 *  Both verbs are categoriser triggers: GET re-checks pending on demand,
 *  POST {recat} force-relabels (one name, or everything pending).
 *  Any hit arms the fs watcher once — force-set on post, process-wide. */
import { NextResponse } from 'next/server';
import { listArtifacts } from '@/lib/artifacts';
import { metaTrigger, metaVersion, sesSlug, startMetaWatcher } from '@/lib/artifact-meta';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  startMetaWatcher();
  metaTrigger();
  const files = await listArtifacts();
  const withMeta = new URL(req.url).searchParams.get('meta') === '1';
  if (!withMeta) {
    return NextResponse.json(files, {
      headers: { 'X-Meta-Version': await metaVersion(), 'Cache-Control': 'no-store' },
    });
  }
  const { readMeta } = await import('@/lib/artifact-meta');
  const meta = await readMeta();
  const slugs = new Map<string, string>();
  const out = files.map((f) => {
    const it = meta.items[f.name];
    if (!it) return f;
    return { ...f, cat: it.cat, note: it.note, ses: it.ses };
  });
  // resolve slugs once per distinct ses (server-side — the client never
  // talks to opencode directly)
  const uniq = [...new Set(out.map((f) => (f as { ses?: string }).ses).filter(Boolean))] as string[];
  await Promise.all(
    uniq.map(async (sid) => slugs.set(sid, (await sesSlug(sid)) || ''))
  );
  const merged = out.map((f) => {
    const ses = (f as { ses?: string }).ses;
    return ses ? { ...f, slug: slugs.get(ses) || null } : f;
  });
  return NextResponse.json(merged, {
    headers: { 'X-Meta-Version': await metaVersion(), 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: Request) {
  startMetaWatcher();
  let recat: string | undefined;
  let recent = false;
  try {
    const b = await req.json();
    recat = typeof b?.recat === 'string' ? b.recat : undefined;
    recent = b?.recent === true;
  } catch {
    /* empty body = re-cat everything pending */
  }
  // header re-cat must always DO something visible: it forces the ten
  // newest files through the model again (bypasses the cooldown), instead
  // of only the pending set — which is usually empty (user req)
  const forceNames = recent
    ? (await listArtifacts())
        .filter((f) => !/e2e/i.test(f.name)) // the categoriser skips debris too
        .slice(0, 10)
        .map((f) => f.name)
    : recat
      ? [recat]
      : undefined;
  const m = await import('@/lib/artifact-meta');
  const n = await m.categorizePending(forceNames);
  return NextResponse.json({ recategorised: n });
}

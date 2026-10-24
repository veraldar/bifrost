/** POST /api/session/[id]/abort → abort a running opencode generation. */
import { NextResponse } from 'next/server';
import { ocFetch, PIN_HEADER, resolveId, sessionGone } from '@/lib/oc';
import { runEnded } from '@/lib/oc-forward';
import { markAborted } from '@/lib/oc-live';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sid = await resolveId(id, req.headers.get(PIN_HEADER));
    markAborted(sid); // deliberate stop — forward's verify must not re-fire it
    await ocFetch(`/session/${sid}/abort`, { method: 'POST' });
    // stop ends the run — including a zombie's: a registry entry whose owning
    // fetch died in a proxy restart gets no .finally of its own, so without
    // this the dot keeps blinking and refresh brings "working…" back
    runEnded(sid, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return sessionGone(e) ?? NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

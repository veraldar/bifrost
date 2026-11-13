/** GET /api/tree → the brain's GET /tree: one row per session
 *  {id, title, parentID, agent, model, card, archived, busy, depth, inbox,
 *  updated}, parents first. Cheap (no transcripts) — the session page reads
 *  its own card from it and links `→ <title>` route tags against it. A brain
 *  without /tree (opencode, an older yggdrasil) answers 502 — the page then
 *  simply shows nothing new. */
import { NextResponse } from 'next/server';
import { ocFetch } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await ocFetch('/tree');
    return NextResponse.json(Array.isArray(rows) ? rows : [], {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

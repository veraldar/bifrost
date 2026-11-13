/**
 * GET (header x-join-secret) → the joining machine's poll (contract v1):
 *   202 { status: "pending" }
 *   200 { status: "approved", root_id, root_secret, link_tokens, rootlink_url,
 *         peer_token, hub: "local" }   — delivered ONCE, then 410
 *   410 { status: "refused" | "expired" }
 * No device auth: the join secret is the credential (only its hash is kept).
 */
import { NextResponse } from 'next/server';
import { NO_STORE } from '@/lib/pairing';
import { pollJoin } from '@/lib/roots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ req: string }> }) {
  const { req: id } = await ctx.params;
  const out = await pollJoin(id, (req.headers.get('x-join-secret') || '').trim().toLowerCase());
  return NextResponse.json(out.body, { status: out.http, headers: NO_STORE });
}

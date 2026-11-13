/**
 * POST → the owner's phone approves a join (contract v1). A live DEVICE only —
 * never the admin token or the box console: the device's id becomes the dev
 * claim of the new root's link tokens, and the root lands in THIS device's
 * allowlist. Mints 20 link tokens (trunk CLI), stores the root credential's
 * hash, holds the raw result for the joiner's one poll.
 */
import { NextResponse } from 'next/server';
import { deviceOf } from '@/lib/admin';
import { NO_STORE } from '@/lib/pairing';
import { approveJoin } from '@/lib/roots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, ctx: { params: Promise<{ req: string }> }) {
  const dev = await deviceOf(req);
  if (!dev) {
    return NextResponse.json(
      { error: 'a paired device approves joins', reauth: 'pair' },
      { status: 401 }
    );
  }
  const out = await approveJoin((await ctx.params).req, dev.id);
  return NextResponse.json(out.body, { status: out.http, headers: NO_STORE });
}

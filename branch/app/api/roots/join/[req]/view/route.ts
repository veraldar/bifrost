/**
 * GET → what the /join page shows the approving phone: name, os, host, the
 * comparison code, status. A live device only (no secrets in it, but a join
 * request is the owner's business).
 */
import { NextResponse } from 'next/server';
import { deviceOf } from '@/lib/admin';
import { NO_STORE } from '@/lib/pairing';
import { viewJoin } from '@/lib/roots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ req: string }> }) {
  if (!(await deviceOf(req))) {
    return NextResponse.json(
      { error: 'a paired device approves joins', reauth: 'pair' },
      { status: 401 }
    );
  }
  const v = viewJoin((await ctx.params).req);
  if (!v) return NextResponse.json({ error: 'unknown join request' }, { status: 404 });
  return NextResponse.json(v, { headers: NO_STORE });
}

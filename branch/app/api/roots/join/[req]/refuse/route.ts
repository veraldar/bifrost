/** POST → the owner's phone refuses a join; the joiner's next poll gets 410 refused. */
import { NextResponse } from 'next/server';
import { deviceOf } from '@/lib/admin';
import { NO_STORE } from '@/lib/pairing';
import { refuseJoin } from '@/lib/roots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, ctx: { params: Promise<{ req: string }> }) {
  const dev = await deviceOf(req);
  if (!dev) {
    return NextResponse.json(
      { error: 'a paired device refuses joins', reauth: 'pair' },
      { status: 401 }
    );
  }
  const out = await refuseJoin((await ctx.params).req, dev.id);
  return NextResponse.json(out.body, { status: out.http, headers: NO_STORE });
}

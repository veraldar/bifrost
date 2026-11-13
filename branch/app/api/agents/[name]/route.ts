/** /api/agents/[name] → the brain's /agent/:name — GET the detail, PUT a
 *  partial edit (creates the agent when it is new), DELETE a custom one.
 *  The brain's refusals (400 + one human sentence: bad name, model not
 *  served, the coordinator's locks, built-ins can't be deleted) come back
 *  with their status — the editor says them where the user tapped. */
import { NextResponse } from 'next/server';
import { OC } from '@/lib/oc';

export const dynamic = 'force-dynamic';

const NAME = /^[A-Za-z0-9_-]+$/;

async function relay(name: string, method: string, body?: unknown) {
  if (!NAME.test(name)) {
    return NextResponse.json(
      { error: 'agent names are letters, digits, - and _' },
      { status: 400 }
    );
  }
  try {
    const r = await fetch(`${OC}/agent/${name}`, {
      method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const why = d?.error || `brain ${r.status} on /agent/${name}`;
      return NextResponse.json({ error: String(why) }, { status: r.status < 500 ? r.status : 502 });
    }
    return NextResponse.json(d);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

type Ctx = { params: Promise<{ name: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return relay((await ctx.params).name, 'GET');
}

export async function PUT(req: Request, ctx: Ctx) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'nothing to save' }, { status: 400 });
  }
  return relay((await ctx.params).name, 'PUT', body);
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return relay((await ctx.params).name, 'DELETE');
}

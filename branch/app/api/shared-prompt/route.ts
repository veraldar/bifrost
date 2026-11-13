/** /api/shared-prompt → the brain's /shared-prompt: the system prompt every agent reads first,
 *  stored once. GET it; PUT {prompt} edits it for every agent (empty = the default). */
import { NextResponse } from 'next/server';
import { OC } from '@/lib/oc';

export const dynamic = 'force-dynamic';

async function relay(method: string, body?: unknown) {
  try {
    const r = await fetch(`${OC}/shared-prompt`, {
      method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const why = d?.error || `brain ${r.status} on /shared-prompt`;
      return NextResponse.json({ error: String(why) }, { status: r.status < 500 ? r.status : 502 });
    }
    return NextResponse.json(d);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function GET() {
  return relay('GET');
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.prompt !== 'string') {
    return NextResponse.json({ error: 'send {prompt}' }, { status: 400 });
  }
  return relay('PUT', { prompt: body.prompt });
}

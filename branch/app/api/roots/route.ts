/** GET → the machines joined to this hub's tree: id, name, os, host, joined_at. A live device only. */
import { NextResponse } from 'next/server';
import { deviceOf } from '@/lib/admin';
import { NO_STORE } from '@/lib/pairing';
import { listRoots } from '@/lib/roots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  if (!(await deviceOf(req))) {
    return NextResponse.json({ error: 'device token required', reauth: 'pair' }, { status: 401 });
  }
  return NextResponse.json({ roots: await listRoots() }, { headers: NO_STORE });
}

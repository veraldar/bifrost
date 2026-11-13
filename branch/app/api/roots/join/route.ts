/**
 * POST { name, os, host } → a join request from a NEW machine (contract v1,
 * docs/spec-join.md). No device auth — the machine has none yet — so it is
 * rate-limited per client address (5 per 10 min) and grants nothing by
 * itself: a paired device must approve it at `approve_url`. At most
 * BIFROST_JOIN_MAX_PENDING (32) joins wait at once → 503 beyond.
 *
 * → 201 { req, secret, code, approve_url, poll_url, expires_in }
 *   `secret` is shown once (only its sha256 is kept); `code` is printed on
 *   both screens so the owner can compare them before approving.
 */
import { NextResponse } from 'next/server';
import { NO_STORE } from '@/lib/pairing';
import { peerOf } from '@/lib/region';
import { clean, createJoin, joinLimit } from '@/lib/roots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const rl = joinLimit(peerOf(req));
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'too many join requests from this address — try again later' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter), ...NO_STORE } }
    );
  }
  const body = await req.json().catch(() => null);
  const name = clean(body?.name, 40);
  const os = clean(body?.os, 24);
  const host = clean(body?.host, 64);
  if (!name && !host) {
    return NextResponse.json({ error: 'name (or host) required' }, { status: 400 });
  }
  const j = createJoin({ name: name || host, os, host }, peerOf(req));
  if (!j) {
    return NextResponse.json(
      { error: 'too many joins waiting for approval — try again later' },
      { status: 503, headers: { 'Retry-After': '60', ...NO_STORE } }
    );
  }
  const base = (process.env.BIFROST_PUBLIC_URL || new URL(req.url).origin).replace(/\/$/, '');
  return NextResponse.json(
    {
      req: j.req,
      secret: j.secret,
      code: j.code,
      approve_url: `${base}/join?r=${j.req}`,
      poll_url: `${base}/api/roots/join/${j.req}`,
      expires_in: j.expires_in,
    },
    { status: 201, headers: NO_STORE }
  );
}

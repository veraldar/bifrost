/**
 * POST (header x-root-secret) → 20 more single-use link tokens for a joined
 * root (contract v1). The root's long-lived credential is the auth (only its
 * sha256 is stored); limited per root after authentication (6 per hour).
 *   200 { link_tokens }  401 bad id/secret  409 approving device revoked
 *   429 rate limited (Retry-After)  503 minting not configured
 */
import { NextResponse } from 'next/server';
import { NO_STORE } from '@/lib/pairing';
import { refillTokens } from '@/lib/roots';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, ctx: { params: Promise<{ root: string }> }) {
  const { root } = await ctx.params;
  const out = await refillTokens(
    root,
    (req.headers.get('x-root-secret') || '').trim().toLowerCase()
  );
  const headers: Record<string, string> = { ...NO_STORE };
  if ('retryAfter' in out && out.retryAfter) headers['Retry-After'] = String(out.retryAfter);
  return NextResponse.json(out.body, { status: out.http, headers });
}

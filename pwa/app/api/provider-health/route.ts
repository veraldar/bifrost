/**
 * GET /api/provider-health → the brain's provider state for the banner.
 *
 * PROVIDER-WAVE (10-28): the root (yggdrasil) serves GET /provider/health —
 * per provider: status (ok | exhausted | limited | auth | down | error |
 * unknown), until, resetsAt, headline. The page shows "provider limit
 * exhausted, resets 20:44" from it even BEFORE a turn fails in this session
 * (another session, or the voice agent, hit the limit first). opencode and
 * the frozen root have no such route → `{known: false}`, never an error: the
 * transcript's error turns still carry the banner there.
 * Only the default's status/reset/headline leave this route — no URLs, no key
 * sources (the root never serves keys; this narrows further).
 */
import { NextResponse } from 'next/server';
import { OC } from '@/lib/oc';

export const dynamic = 'force-dynamic';

const OUT = new Set(['exhausted', 'limited', 'auth', 'down', 'error']);

export async function GET() {
  try {
    const r = await fetch(`${OC}/provider/health`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!r.ok) return NextResponse.json({ known: false }, { headers: { 'Cache-Control': 'no-store' } });
    const h = (await r.json()) as {
      model?: string;
      default?: { status?: string; until?: number; resetsAt?: number; lastError?: { kind?: string; message?: string; code?: string; statusCode?: number } };
      chain?: string[];
    };
    const d = h.default || {};
    const out = !!d.status && OUT.has(d.status) && (!d.until || d.until > Date.now());
    return NextResponse.json(
      {
        known: true,
        model: h.model,
        status: d.status || 'unknown',
        out,
        fallback: (h.chain || []).slice(1),
        ...(out && d.lastError
          ? {
              alert: {
                kind: d.lastError.kind || 'error',
                message: d.lastError.message || '',
                resetsAt: d.resetsAt,
                code: d.lastError.code,
                statusCode: d.lastError.statusCode,
                providerID: h.model?.split('/')[0],
                modelID: h.model?.split('/').slice(1).join('/'),
              },
            }
          : {}),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ known: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

/** GET /api/brain-dialect → which brain the served app is bound to
 *  (`yggdrasil` | `opencode`). One honest word, no guessing on the client:
 *  e2e (and diagnostics) assert the right law on the right stack — e.g.
 *  context injection is an opencode property today, yggdrasil's is filed
 *  (docs/open-questions.md OG-ctx). Asked of the brain itself, never read
 *  off its port: only yggdrasil serves its triad map (`GET /session/state`)
 *  as JSON — opencode answers unknown paths with its web app's HTML. */
import { OC } from '@/lib/oc';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  let dialect = 'opencode';
  try {
    const r = await fetch(`${OC}/session/state`, { signal: AbortSignal.timeout(5_000) });
    const body = r.ok ? await r.json().catch(() => null) : null;
    if (body && typeof body === 'object' && !Array.isArray(body)) dialect = 'yggdrasil';
  } catch {
    /* brain down — say opencode, the default stack */
  }
  return new Response(dialect, { headers: { 'Cache-Control': 'no-store' } });
}

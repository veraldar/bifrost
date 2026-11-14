/** GET /api/harness/claude/sessions → the brain's newest Claude Code sessions on this box
 *  ({id, cwd, modified, title} — metadata only), to continue one from the phone. */
import { NextResponse } from 'next/server';
import { ocFetch } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await ocFetch('/harness/claude/sessions'));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

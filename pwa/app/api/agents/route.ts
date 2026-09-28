/** GET /api/agents → selectable agent profiles for the settings picker.
 *  opencode marks its utility prompts (title / summary / compaction — the
 *  internal session-titling and compaction jobs) as mode=primary too, so a
 *  mode filter alone would show them as agents. Excluded by name. */
import { NextResponse } from 'next/server';
import { ocFetch } from '@/lib/oc';

export const dynamic = 'force-dynamic';

type AgentEntry = { name?: string; description?: string; mode?: string };

const UTILITY = new Set(['title', 'summary', 'compaction']);

export async function GET() {
  try {
    const list = (await ocFetch('/agent')) as AgentEntry[];
    const out = (list || [])
      .filter(
        (a) => a.name && a.mode === 'primary' && !UTILITY.has(a.name.toLowerCase())
      )
      .map((a) => ({ name: a.name!, description: a.description || '' }));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

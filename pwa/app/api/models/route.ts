/** GET /api/models → provider/model list for the settings picker.
 *  Compact projection of opencode /config/providers — deliberately narrow
 *  so provider credentials (the raw response carries API keys) never reach
 *  the client. Think-level derivatives (`<model>-think-<level>`, selected
 *  through the THINK tile) are not models — kept out of the picker. */
import { NextResponse } from 'next/server';
import { ocFetch } from '@/lib/oc';

export const dynamic = 'force-dynamic';

type ProvidersResponse = {
  providers?: Array<{
    id: string;
    name?: string;
    models?: Record<
      string,
      { id?: string; name?: string; variants?: Record<string, unknown> }
    >;
  }>;
};

export async function GET() {
  try {
    const d = (await ocFetch('/config/providers')) as ProvidersResponse;
    const out = (d.providers || []).map((p) => ({
      id: p.id,
      name: p.name || p.id,
      models: Object.values(p.models || {})
        .filter((m) => !(m.id || '').includes('-think-'))
        .map((m) => ({
          id: m.id || '',
          name: m.name || m.id || '',
          variants: m.variants ? Object.keys(m.variants) : [],
        })),
    }));
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

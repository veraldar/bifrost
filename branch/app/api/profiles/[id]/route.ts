/** GET /api/profiles/[id] → one agent profile {name, tools[]} (plus its
 *  description), read-only, from the registry — never an edit surface. */
import { NextResponse } from 'next/server';
import { getProfile, ProfilesError } from '@/lib/profiles';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const profile = await getProfile(id);
    if (!profile) {
      return NextResponse.json({ error: `no profile “${id}”` }, { status: 404 });
    }
    return NextResponse.json({
      name: profile.id,
      description: profile.description,
      tools: profile.tools,
      isDefault: profile.isDefault,
    });
  } catch (e) {
    const status = e instanceof ProfilesError ? e.status : 500;
    return NextResponse.json({ error: String(e) }, { status });
  }
}

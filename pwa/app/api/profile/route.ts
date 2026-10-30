/** GET /api/profile — the brain's session tool profiles (opencode /agent
 *  element shape + default), for the new-session picker. A brain without
 *  the feature (GET /profile 404) answers {profiles: null}: the UI runs
 *  default-only, byte-identical to before. Any other brain failure is a
 *  loud 500, never a silent 'no profiles'. */
import { NextResponse } from 'next/server';
import { defaultProfile, profilesFor } from '@/lib/profiles';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const profiles = await profilesFor();
    // the brain's own default name rides along — the picker's first option
    // reads it (never a UI-hardcoded 'build')
    const def = profiles ? await defaultProfile() : null;
    return NextResponse.json({ profiles, default: def });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** GET /api/profiles → the root's agent profiles, read-only. Rendered by
 *  /settings/profiles (the list and each profile's page) —
 *  the registry stays AI-owned; the PWA shows it, never edits it. */
import { NextResponse } from 'next/server';
import { listProfiles, ProfilesError } from '@/lib/profiles';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await listProfiles());
  } catch (e) {
    const status = e instanceof ProfilesError ? e.status : 500;
    return NextResponse.json({ error: String(e) }, { status });
  }
}

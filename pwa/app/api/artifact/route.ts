/** GET /api/artifact → every artifact the user can see, for the /artifacts
 *  gallery and the home bell: this checkout's artifacts/, the main tree's
 *  (from a worktree) and the app's built-ins, one row per name — name,
 *  mtime, size, served type, source. Newest first. */
import { NextResponse } from 'next/server';
import { listArtifacts } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await listArtifacts());
}

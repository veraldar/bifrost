/** GET /api/artifact → list of everything in bifrost/artifacts/ for the
 *  /artifacts gallery: name, mtime, size, served type. Newest first. */
import { NextResponse } from 'next/server';
import { listArtifacts } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await listArtifacts());
}

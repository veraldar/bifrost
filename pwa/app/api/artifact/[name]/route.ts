/** GET /api/artifact/[name] → files the agents dropped (this checkout's
 *  artifacts/, the main tree's when running from a worktree) or the app's
 *  own built-ins (pwa/artifacts-builtin — the door's tree film), so the
 *  phone can render them inline in the chat (markdown images / sandboxed
 *  iframes). Name is sanitized; which file a name means is decided by
 *  lib/artifacts' one rule, shared with the /artifacts gallery. */
import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { ARTIFACT_TYPES, resolveArtifact, safeArtifactName } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!safeArtifactName(name)) {
    return NextResponse.json({ error: 'bad name' }, { status: 400 });
  }
  const ext = path.extname(name).toLowerCase();
  if (!ARTIFACT_TYPES[ext]) return NextResponse.json({ error: 'unsupported type' }, { status: 415 });
  const hit = await resolveArtifact(name);
  if (hit) {
    try {
      const data = await readFile(hit.file);
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': hit.type,
          // long enough to cache during a chat, short enough to pick up rewrites
          'Cache-Control': 'no-store',
          'X-Artifact-Source': hit.source,
        },
      });
    } catch {
      /* raced a delete */
    }
  }
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}

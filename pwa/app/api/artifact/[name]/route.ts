/** GET /api/artifact/[name] → files the opencode agent dropped into
 *  bifrost/artifacts/ so the phone can render them inline in the chat
 *  (markdown images / sandboxed iframes). Name is sanitized; the type map
 *  and dir are shared with the /artifacts gallery via lib/artifacts. A name
 *  the agents' dir doesn't hold falls back to the app's own built-ins
 *  (pwa/artifacts-builtin — the door's tree film). */
import { NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { ARTIFACTS_DIR, ARTIFACT_TYPES, BUILTIN_ARTIFACTS_DIR } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  // traversal guard: a bare sanitized filename only
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes('..')) {
    return NextResponse.json({ error: 'bad name' }, { status: 400 });
  }
  const ext = path.extname(name).toLowerCase();
  const type = ARTIFACT_TYPES[ext];
  if (!type) return NextResponse.json({ error: 'unsupported type' }, { status: 415 });
  for (const dir of [ARTIFACTS_DIR, BUILTIN_ARTIFACTS_DIR]) {
    try {
      const file = path.join(dir, name);
      if (!(await stat(file)).isFile()) continue;
      const data = await readFile(file);
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': type,
          // long enough to cache during a chat, short enough to pick up rewrites
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      /* not in this dir */
    }
  }
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}

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

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!safeArtifactName(name)) {
    return NextResponse.json({ error: 'bad name' }, { status: 400 });
  }
  const ext = path.extname(name).toLowerCase();
  // the type comes from the extension alone — no extension is no file we
  // could serve, which is a 404 (a 415 read as "wrong format" for a name
  // that never existed, 10-24 /api/artifact/the-tree-film)
  if (!ext) {
    return NextResponse.json(
      { error: 'not found — artifact names carry their extension (the door films: door-tree.html, far-vision.html)' },
      { status: 404 }
    );
  }
  if (!ARTIFACT_TYPES[ext]) return NextResponse.json({ error: 'unsupported type' }, { status: 415 });
  const hit = await resolveArtifact(name);
  if (hit) {
    try {
      const data = await readFile(hit.file);
      // top-level navigation (address bar / new tab) of a text artifact:
      // browsers paint raw text white — wrap it in the app's black so an
      // opened md reads like bifrost. Chat fetches (sec-fetch-dest: empty)
      // still get the raw bytes they .text()   [port of main 547cb89]
      if (hit.type.startsWith('text/') && req.headers.get('sec-fetch-dest') === 'document') {
        const esc = data
          .toString('utf-8')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const html =
          `<!doctype html><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>${name}</title>` +
          `<style>html{background:#080810}body{margin:0;background:#080810;color:#fff;` +
          `font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:16px;` +
          `white-space:pre-wrap;word-break:break-word}</style>` +
          `<body>${esc}</body>`;
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
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

/** GET /api/artifact/[name] → files the opencode agent dropped into
 *  bifrost/artifacts/ so the phone can render them inline in the chat
 *  (markdown images / sandboxed iframes). Name is sanitized; the type map
 *  and dir are shared with the /artifacts gallery via lib/artifacts. */
import { NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { ARTIFACT_TYPES, ARTIFACTS_DIR } from '@/lib/artifacts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  // traversal guard: a bare sanitized filename only
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes('..')) {
    return NextResponse.json({ error: 'bad name' }, { status: 400 });
  }
  const ext = path.extname(name).toLowerCase();
  const type = ARTIFACT_TYPES[ext];
  if (!type) return NextResponse.json({ error: 'unsupported type' }, { status: 415 });
  try {
    const file = path.join(ARTIFACTS_DIR, name);
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const data = await readFile(file);
    // top-level navigation (address bar / new tab) of a PLAIN-TEXT artifact
    // (md, txt, code…): browsers paint raw text white — wrap it in the
    // app's black so an opened md reads like bifrost. Html must NOT take
    // this path — text/html navigations are the browser rendering the
    // artifact itself. Chat fetches (sec-fetch-dest: empty) still get the
    // raw bytes they .text()
    if (type.startsWith('text/plain') && req.headers.get('sec-fetch-dest') === 'document') {
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
        'Content-Type': type,
        // long enough to cache during a chat, short enough to pick up rewrites
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}

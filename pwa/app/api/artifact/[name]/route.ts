/** GET /api/artifact/[name] → files the opencode agent dropped into
 *  bifrost/artifacts/ so the phone can render them inline in the chat
 *  (markdown images / sandboxed iframes). Name is sanitized; no listing. */
import { NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(process.cwd(), '..', 'artifacts');

const TEXT = 'text/plain; charset=utf-8';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.txt': TEXT,
  '.md': TEXT,
  '.json': 'application/json',
  '.csv': TEXT,
  '.log': TEXT,
  '.xml': TEXT,
  '.yaml': TEXT,
  '.yml': TEXT,
  '.toml': TEXT,
  '.ini': TEXT,
  '.conf': TEXT,
  '.css': TEXT,
  '.js': TEXT,
  '.mjs': TEXT,
  '.ts': TEXT,
  '.tsx': TEXT,
  '.jsx': TEXT,
  '.py': TEXT,
  '.sh': TEXT,
  '.rb': TEXT,
  '.go': TEXT,
  '.rs': TEXT,
  '.java': TEXT,
  '.c': TEXT,
  '.h': TEXT,
  '.cpp': TEXT,
  '.diff': TEXT,
  '.patch': TEXT,
  '.pdf': 'application/pdf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  // traversal guard: a bare sanitized filename only
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes('..')) {
    return NextResponse.json({ error: 'bad name' }, { status: 400 });
  }
  const ext = path.extname(name).toLowerCase();
  const type = TYPES[ext];
  if (!type) return NextResponse.json({ error: 'unsupported type' }, { status: 415 });
  try {
    const file = path.join(ARTIFACTS_DIR, name);
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const data = await readFile(file);
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

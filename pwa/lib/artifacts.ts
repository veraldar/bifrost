/** Shared artifact plumbing: the dir agents drop files into, the served
 *  extension map, and a directory listing for the /artifacts gallery.
 *  The serving route ([name]) and the list route both live off this. */
import { readdir, stat } from 'fs/promises';
import path from 'path';

export const ARTIFACTS_DIR =
  process.env.ARTIFACTS_DIR || path.join(process.cwd(), '..', 'artifacts');

const TEXT = 'text/plain; charset=utf-8';

export const ARTIFACT_TYPES: Record<string, string> = {
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

export type ArtifactEntry = {
  name: string;
  mtime: number;
  size: number;
  type: string;
};

/** Directory listing for the gallery: sanitized names with a servable
 *  extension only, newest first. Never throws — an unreadable dir is an
 *  empty gallery, not a 500. */
export async function listArtifacts(): Promise<ArtifactEntry[]> {
  let names: string[];
  try {
    names = await readdir(ARTIFACTS_DIR);
  } catch {
    return [];
  }
  const out: ArtifactEntry[] = [];
  for (const name of names) {
    // same guard as the serving route — a bare sanitized filename only
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes('..')) continue;
    const type = ARTIFACT_TYPES[path.extname(name).toLowerCase()];
    if (!type) continue;
    try {
      const st = await stat(path.join(ARTIFACTS_DIR, name));
      if (!st.isFile()) continue;
      out.push({ name, mtime: st.mtimeMs, size: st.size, type });
    } catch {
      /* raced a delete — skip */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

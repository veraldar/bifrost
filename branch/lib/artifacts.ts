/** Shared artifact plumbing: where the user's artifacts live, the served
 *  extension map, the one name → file rule, and the /artifacts listing.
 *  The serving route ([name]) and the list route both live off this, so
 *  the gallery can never list a file the route would not serve (or serve
 *  a different file than the one it listed). */
import { readFileSync, realpathSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import path from 'path';

/** this checkout's drop dir — where an agent working in THIS tree writes */
export const ARTIFACTS_DIR =
  process.env.ARTIFACTS_DIR || path.join(process.cwd(), '..', 'artifacts');
/** artifacts the app itself ships (in git, unlike the agents' dirs): the
 *  door's tree film (door-tree.html) and the far vision. Reserved names —
 *  an agent dropping a same-named file can't swap the door's film. */
export const BUILTIN_ARTIFACTS_DIR = path.join(process.cwd(), 'artifacts-builtin');

/** The main checkout's artifacts/ when this app runs from a git worktree
 *  (the sandbox): delegations and ~/Work/CLAUDE.md drop files THERE, and a
 *  worktree reading only its own dir never showed them (10-24). Derived
 *  from the worktree's .git file — no config to lose. ARTIFACTS_MAIN_DIR
 *  overrides ('' = off); an explicit ARTIFACTS_DIR (the sim stack's
 *  isolated dir) means no implicit main read. On the main checkout .git
 *  is a dir → null: its own dir IS the main one. */
function mainTreeArtifactsDir(): string | null {
  if (process.env.ARTIFACTS_MAIN_DIR !== undefined) return process.env.ARTIFACTS_MAIN_DIR || null;
  if (process.env.ARTIFACTS_DIR) return null;
  try {
    const root = path.join(process.cwd(), '..');
    // a worktree's .git is a file: "gitdir: <main>/.git/worktrees/<name>"
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(root, '.git'), 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(root, m[1].trim());
    const common = path.resolve(gitdir, readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    return path.join(path.dirname(common), 'artifacts');
  } catch {
    return null;
  }
}

/** where a listed/served file came from — the gallery tags non-local ones */
export type ArtifactSource = 'builtin' | 'local' | 'main';

function real(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Lookup order matters only for the precedence rule below. A dir that
 *  resolves to one already listed is dropped (no double rows). */
const SOURCES: { source: ArtifactSource; dir: string }[] = (() => {
  const main = mainTreeArtifactsDir();
  const all: { source: ArtifactSource; dir: string }[] = [
    { source: 'builtin', dir: BUILTIN_ARTIFACTS_DIR },
    { source: 'local', dir: ARTIFACTS_DIR },
    ...(main ? [{ source: 'main' as const, dir: main }] : []),
  ];
  const seen = new Set<string>();
  return all.filter(({ dir }) => {
    const r = real(dir);
    if (seen.has(r)) return false;
    seen.add(r);
    return true;
  });
})();

/** a bare sanitized filename only — the traversal guard for list + serve */
export function safeArtifactName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && !name.includes('..');
}

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
  source: ArtifactSource;
};

/** The one name → file rule (SOURCES order): a built-in name is reserved;
 *  otherwise the newest write wins wherever it landed — a hand copy in the
 *  sandbox can't shadow a newer original in the main tree; a tie stays
 *  with the earlier source (local). */
function outranks(cand: { mtime: number }, prev: { mtime: number; source: ArtifactSource }): boolean {
  return prev.source !== 'builtin' && cand.mtime > prev.mtime;
}

/** Serving lookup: the file the gallery lists under `name`, or null. */
export async function resolveArtifact(
  name: string
): Promise<{ file: string; type: string; source: ArtifactSource } | null> {
  const type = ARTIFACT_TYPES[path.extname(name).toLowerCase()];
  if (!safeArtifactName(name) || !type) return null;
  let best: { file: string; mtime: number; source: ArtifactSource } | null = null;
  for (const { source, dir } of SOURCES) {
    const file = path.join(dir, name);
    try {
      const st = await stat(file);
      if (!st.isFile()) continue;
      if (!best || outranks({ mtime: st.mtimeMs }, best))
        best = { file, mtime: st.mtimeMs, source };
    } catch {
      /* not in this dir */
    }
  }
  return best && { file: best.file, type, source: best.source };
}

async function listDir(source: ArtifactSource, dir: string): Promise<ArtifactEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = await Promise.all(
    names.map(async (name): Promise<ArtifactEntry | null> => {
      if (!safeArtifactName(name)) return null;
      const type = ARTIFACT_TYPES[path.extname(name).toLowerCase()];
      if (!type) return null;
      try {
        const st = await stat(path.join(dir, name));
        return st.isFile() ? { name, mtime: st.mtimeMs, size: st.size, type, source } : null;
      } catch {
        return null; // raced a delete
      }
    })
  );
  return out.filter((e): e is ArtifactEntry => e !== null);
}

/** Gallery listing: every source, one row per name (same rule as the
 *  route), servable extensions only, newest first. Never throws — an
 *  unreadable dir is a missing source, not a 500. */
export async function listArtifacts(): Promise<ArtifactEntry[]> {
  const per = await Promise.all(SOURCES.map(({ source, dir }) => listDir(source, dir)));
  const best = new Map<string, ArtifactEntry>();
  for (const entries of per)
    for (const e of entries) {
      const prev = best.get(e.name);
      if (!prev || outranks(e, prev)) best.set(e.name, e);
    }
  return [...best.values()].sort((a, b) => b.mtime - a.mtime);
}

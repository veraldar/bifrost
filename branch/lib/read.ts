/** Per-session read marks: the list can show "agent replied and you haven't
 *  opened it since" (unread). Phone-local, like chat read receipts. */
const KEY = 'oz-read';

function readAll(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function lastRead(slug: string): number {
  return readAll()[slug] || 0;
}

/** Read up to `at` (latest message time seen) — never goes backwards. */
export function markRead(slug: string, at: number): void {
  if (!slug || !at) return;
  try {
    const all = readAll();
    if ((all[slug] || 0) >= at) return;
    all[slug] = at;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}

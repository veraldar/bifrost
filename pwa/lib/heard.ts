/** Per-session "heard" marks: hands-free auto-plays the last reply when you
 *  open a session (req 09-30) — once. Phone-local, like lib/read.ts. */
const KEY = 'oz-heard';

function heardAll(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function lastHeard(slug: string): number {
  return heardAll()[slug] || 0;
}

/** Mark heard up to `at` (message time) — never goes backwards. */
export function markHeard(slug: string, at: number): void {
  if (!slug || !at) return;
  try {
    const all = heardAll();
    if ((all[slug] || 0) >= at) return;
    all[slug] = at;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}

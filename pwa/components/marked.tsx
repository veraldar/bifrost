import type { ReactNode } from 'react';

/** Highlight every occurrence of q inside text (case-insensitive).
 *  Shared by global-search snippets and in-session hit messages. */
export function Marked({
  text,
  q,
  // search hits are sky (info) — amber is reserved for heard
  className = 'oz-mark',
}: {
  text: string;
  q: string;
  className?: string;
}) {
  const needle = q.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (;;) {
    const i = lower.indexOf(needle, from);
    if (i < 0) break;
    if (i > from) out.push(text.slice(from, i));
    out.push(<mark key={i} className={className}>{text.slice(i, i + needle.length)}</mark>);
    from = i + needle.length;
  }
  out.push(text.slice(from));
  return <>{out}</>;
}

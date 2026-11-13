/** root-coord: the coordinator names where it routed work as `→ <session
 *  title>` ("→ Static recipe site: build session started"). linkRouteTags
 *  turns each tag whose title is a known session (exact title, any case; the
 *  longest title wins) into a markdown link to it — `/session/<slug>?id=<id>`,
 *  the list's own address. Code spans and fences are left alone, and a tag
 *  that names no session stays plain text. */
import { slugify } from './slug';

export type RouteTarget = { id: string; title: string };

// fenced blocks (an unclosed one runs to the end — it is still streaming) and inline code
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;
const TAG = /→[ \t]*/g;
const WORD = /[A-Za-z0-9_]/;

export function routeHref(t: RouteTarget): string {
  return `/session/${slugify(t.title || t.id)}?id=${encodeURIComponent(t.id)}`;
}

function linkSeg(seg: string, list: RouteTarget[]): string {
  let out = '';
  let last = 0;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(seg))) {
    const at = m.index + m[0].length;
    const hit = list.find(
      (t) =>
        seg.slice(at, at + t.title.length).toLowerCase() === t.title.toLowerCase() &&
        !WORD.test(seg.charAt(at + t.title.length))
    );
    if (!hit) continue;
    const end = at + hit.title.length;
    const label = seg.slice(at, end).replace(/[[\]\\]/g, '\\$&');
    out += `${seg.slice(last, at)}[${label}](${routeHref(hit)})`;
    last = TAG.lastIndex = end;
  }
  return out + seg.slice(last);
}

export function linkRouteTags(text: string, targets: RouteTarget[]): string {
  if (!text.includes('→') || !targets.length) return text;
  const list = targets
    .filter((t) => t.title.trim())
    .sort((a, b) => b.title.length - a.title.length);
  // split keeps the code pieces at odd indexes — only prose (even) is linked
  return text
    .split(CODE)
    .map((seg, i) => (i % 2 ? seg : linkSeg(seg, list)))
    .join('');
}

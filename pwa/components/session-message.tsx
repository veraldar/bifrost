'use client';

import { useState } from 'react';
import { Streamdown } from 'streamdown';
import { Marked } from '@/components/marked';
import { useSwipeX } from '@/lib/use-swipe-x';

export type Msg = {
  role: string;
  text: string;
  images: string[];
  time: number;
  queued?: boolean;
  done?: boolean; // assistant: run completed (hands-free auto-listen gate)
};

function htmlBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```html\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

/** Split a user message into prose and attached-file segments (proxy fences files). */
function fileChunks(text: string): { kind: 'prose' | 'file'; name?: string; body: string }[] {
  const out: { kind: 'prose' | 'file'; name?: string; body: string }[] = [];
  const re = /\n?--- attached file: ([^\n]+) ---\n```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: 'prose', body: text.slice(last, m.index) });
    out.push({ kind: 'file', name: m[1], body: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'prose', body: text.slice(last) });
  return out;
}

function fmtTime(t: number): string {
  if (!t) return '';
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Committed horizontal swipe on a message opens the history browser; the
 *  threshold itself lives in useSwipeX (48px default). */

export function SessionMessage({
  m,
  queued,
  mi,
  hit,
  q = '',
  onOpenHistory,
}: {
  m: Msg;
  queued?: boolean;
  /** index in the session's message list — the search jump target anchor */
  mi?: number;
  /** transcript search hit — ring the whole message (markdown-safe) */
  hit?: boolean;
  /** active search term — marked inside user prose (assistant goes through
   *  markdown, only ringed) */
  q?: string;
  /** horizontal swipe on the message: 'older' = dragged right (into the
   *  past), 'newer' = dragged left (back toward the present) */
  onOpenHistory?: (mi: number, dir: 'older' | 'newer') => void;
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  // html blocks render directly (sandboxed); this holds the one showing code
  const [rawIdx, setRawIdx] = useState(-1);
  const isUser = m.role === 'user';
  const htmls = isUser ? [] : htmlBlocks(m.text);
  const stamp = fmtTime(m.time);
  // horizontal swipe on the message → history browser (touch-safe: the hook
  // preventDefaults native scroll before it claims the gesture)
  const swipeRef = useSwipeX<HTMLDivElement>({
    onCommit: (dir) => {
      if (onOpenHistory && mi !== undefined) onOpenHistory(mi, dir);
    },
    ignoreStart: (t) => !!(t instanceof HTMLElement && t.closest('[data-lightbox]')),
  });

  return (
    <div
      ref={swipeRef}
      data-mi={mi}
      style={{ touchAction: 'pan-y' }}
      className={`scroll-mt-24 text-sm leading-relaxed break-words ${
        hit
          ? '-mx-2 rounded border border-[var(--oz-active)] bg-[var(--oz-active)]/10 px-2 py-1'
          : ''
      }`}
    >
      <div className="mb-0.5 flex items-baseline gap-2">
        <span className={isUser ? 'text-[var(--oz-success)]' : 'text-[var(--oz-dim)]'}>
          ({isUser ? 'you' : m.role})
        </span>
        {stamp && <span className="text-[10px] text-[var(--oz-dim)]">{stamp}</span>}
        {queued && <span className="oz-busy text-[10px] text-[var(--oz-active)]">● queued</span>}
      </div>
      {isUser ? (
        fileChunks(m.text).map((c, i) =>
          c.kind === 'prose' ? (
            <span key={i} className="whitespace-pre-wrap">
              <Marked text={c.body} q={q} />
            </span>
          ) : (
            <details
              key={i}
              className="my-1 rounded border border-[var(--oz-border)] px-2 py-1 text-xs"
            >
              <summary className="cursor-pointer text-[var(--oz-dim)]">📎 {c.name}</summary>
              <pre className="mt-1 max-h-40 overflow-auto text-[10px] whitespace-pre-wrap text-[var(--oz-dim)]">
                {c.body.slice(0, 4000)}
                {c.body.length > 4000 ? '…' : ''}
              </pre>
            </details>
          )
        )
      ) : (
        <Streamdown>{m.text}</Streamdown>
      )}

      {/* html blocks render inline by default (sandbox="" — no scripts, no
          forms, no same-origin); tap toggles the raw code view */}
      {htmls.map((src, i) => (
        <div key={`h${i}`} className="mt-1">
          <button
            onClick={() => setRawIdx(rawIdx === i ? -1 : i)}
            className="flex w-fit items-center gap-1 rounded border border-[var(--oz-border)] px-2 py-0.5 text-[10px] text-[var(--oz-dim)]"
          >
            {rawIdx === i ? 'show rendered' : 'show code'}
          </button>
          {rawIdx === i ? (
            <pre className="mt-1 max-h-40 overflow-auto text-[10px] whitespace-pre-wrap text-[var(--oz-dim)]">
              {src.slice(0, 4000)}
              {src.length > 4000 ? '…' : ''}
            </pre>
          ) : (
            <iframe
              sandbox=""
              srcDoc={src}
              title={`html preview ${i + 1}`}
              className="mt-1 h-64 w-full rounded border border-[var(--oz-border)] bg-white"
            />
          )}
        </div>
      ))}

      {m.images?.map((src, j) =>
        src ? (
          <button key={`i${j}`} onClick={() => setLightbox(src)} className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt="attachment"
              className="mt-1 max-h-48 rounded border border-[var(--oz-border)]"
            />
          </button>
        ) : null
      )}

      {lightbox && (
        <div
          data-lightbox
          onClick={() => setLightbox(null)}
          onPointerDown={(e) => e.stopPropagation()}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="attachment" className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}

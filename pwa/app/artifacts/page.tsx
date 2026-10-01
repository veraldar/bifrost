'use client';

/** /artifacts — everything the agents dropped into bifrost/artifacts/,
 *  newest first, day-grouped. Unread = file mtime newer than the version
 *  you last opened (phone-local watermarks, lib/artifact-read). Tapping a
 *  row opens the artifact right here — same rendering rules as the chat —
 *  and marks it seen, which drops the home bell badge.
 *
 *  Defaults to an html-only gallery with live thumbnails (the design
 *  mockups are what you come here for); "all" shows every file. */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Streamdown } from 'streamdown';
import { PixelIcon } from '@/components/pixel-icon';
import type { ArtifactEntry } from '@/lib/artifacts';
import { countUnseen, lastSeen, markAllSeen, markSeen, seenInit } from '@/lib/artifact-read';

// instant paint on back-navigation, same trick as the sessions list
const CACHE_KEY = 'oz-artifacts';

type Kind = 'image' | 'html' | 'md' | 'text' | 'pdf' | 'audio';

const KIND: Record<string, Kind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  html: 'html',
  md: 'md',
  txt: 'text', json: 'text', csv: 'text', log: 'text', xml: 'text',
  yaml: 'text', yml: 'text', toml: 'text', ini: 'text', conf: 'text',
  css: 'text', js: 'text', mjs: 'text', ts: 'text', tsx: 'text', jsx: 'text',
  py: 'text', sh: 'text', rb: 'text', go: 'text', rs: 'text', java: 'text',
  c: 'text', h: 'text', cpp: 'text', diff: 'text', patch: 'text',
  pdf: 'pdf',
  wav: 'audio', mp3: 'audio',
};

function kindOf(name: string): Kind {
  return KIND[name.split('.').pop()?.toLowerCase() || ''] || 'text';
}

/** One type letter for the row glyph — the unread dot does the talking,
 *  this only disambiguates. */
function glyphOf(name: string): string {
  const k = kindOf(name);
  if (k === 'image') return '▣';
  if (k === 'html') return '▤';
  if (k === 'audio') return '♪';
  if (k === 'pdf') return '▦';
  if (k === 'md') return '¶';
  return '·';
}

function fmtTime(t: number): string {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

function dayLabel(t: number): string {
  const d = new Date(t).toDateString();
  if (d === new Date().toDateString()) return 'today';
  if (d === new Date(Date.now() - 86400e3).toDateString()) return 'yesterday';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Full-page viewer for the non-html artifacts — rendering rules match the
 *  chat (session-message ArtifactView): md rendered, text fetched and
 *  capped, pdf a tap-out card, audio inline. Html goes to its own
 *  full-screen page (/artifacts/view/[name]) instead. */
function Viewer({ file }: { file: ArtifactEntry }) {
  const kind = kindOf(file.name);
  const src = `/api/artifact/${encodeURIComponent(file.name)}`;
  const [text, setText] = useState<string | null>(null);
  const needsText = kind === 'md' || kind === 'text';

  useEffect(() => {
    if (!needsText) return;
    let live = true;
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => live && setText(t))
      .catch(() => live && setText(null));
    return () => {
      live = false;
    };
  }, [src, needsText]);

  if (kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={file.name}
        className="max-h-[calc(100dvh-10rem)] w-full rounded border border-[var(--oz-border)] object-contain"
      />
    );
  }
  if (kind === 'audio') {
    return <audio controls src={src} className="w-full" preload="metadata" />;
  }
  if (kind === 'pdf') {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="flex w-fit items-center gap-1 rounded border border-[var(--oz-border)] px-2 py-1 text-xs text-[var(--oz-active)]"
      >
        ▦ {file.name} — tap to view
      </a>
    );
  }
  if (text === null) return <div className="text-xs text-[var(--oz-dim)]">loading…</div>;
  const body = text.length > 20000 ? `${text.slice(0, 20000)}…` : text;
  return (
    <div className="max-h-[calc(100dvh-10rem)] overflow-auto rounded border border-[var(--oz-border)] px-2 py-1">
      {kind === 'md' ? (
        <div className="text-sm">
          <Streamdown>{body}</Streamdown>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words text-xs text-[var(--oz-text)]/85">{body}</pre>
      )}
    </div>
  );
}

/** Live thumbnail for an html artifact: the real page in a scriptless
 *  iframe, scaled into a 3:2 card (top-left corner at 25%). Lazy —
 *  offscreen cards don't load their page until scrolled to. The iframe is
 *  pointer-transparent: a thumbnail must never steal a scroll — on the
 *  phone the embedded page would swallow the swipe and scroll itself. */
function HtmlThumb({ name }: { name: string }) {
  const src = `/api/artifact/${encodeURIComponent(name)}`;
  return (
    <div className="relative aspect-[3/2] w-full overflow-hidden bg-[var(--oz-surface-hover)]">
      <iframe
        sandbox=""
        loading="lazy"
        scrolling="no"
        aria-hidden="true"
        tabIndex={-1}
        src={src}
        title={`${name} preview`}
        className="pointer-events-none absolute left-0 top-0 h-[400%] w-[400%] origin-top-left scale-[.25] border-0 bg-white"
      />
    </div>
  );
}

export default function ArtifactsPage() {
  const router = useRouter();
  const [files, setFiles] = useState<ArtifactEntry[]>(() => {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as ArtifactEntry[]) : [];
    } catch {
      return [];
    }
  });
  const [open, setOpen] = useState<ArtifactEntry | null>(null);
  // html-only gallery is the default — that's what agents make for you;
  // "all" reveals everything else (md, png, wav, diffs…)
  const [filter, setFilter] = useState<'html' | 'all'>('html');
  const loadInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    try {
      const r = await fetch('/api/artifact', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      const list: ArtifactEntry[] = await r.json();
      setFiles(list);
      seenInit(list); // first run mercy: everything already on disk counts as seen
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(list));
      } catch {
        /* quota — skip cache */
      }
    } catch {
      /* transient — keep showing the stale list */
    } finally {
      loadInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (!document.hidden && !open) void load();
    }, 8000);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load, open]);

  // recompute unread after every seen-marking — watermarks live in
  // localStorage, so a tick is all the render needs
  const [, setTick] = useState(0);
  const touch = useCallback(() => setTick((n) => n + 1), []);
  // html goes full-screen on its own page — a thumbnail promises the whole
  // design, not a letterboxed strip; everything else uses the in-page viewer
  const openArtifact = useCallback(
    (f: ArtifactEntry) => {
      markSeen(f.name, f.mtime);
      touch();
      if (kindOf(f.name) === 'html') router.push(`/artifacts/view/${encodeURIComponent(f.name)}`);
      else setOpen(f);
    },
    [router, touch]
  );
  const unread = countUnseen(files);
  const isHtml = (f: ArtifactEntry) => kindOf(f.name) === 'html';
  const rows = files.map((f) => ({ f, isUnread: f.mtime > lastSeen(f.name) }));
  const viewRows = filter === 'html' ? rows.filter((r) => isHtml(r.f)) : rows;
  const emptyMsg =
    filter === 'html'
      ? 'no html artifacts yet — switch to all for the rest'
      : 'no artifacts yet — agents drop files here and they show up in chat';

  return (
    <>
      <div aria-hidden="true" className="oz-ygg-bg" />
      <main className="relative z-[1] mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
        <header className="mt-4 mb-2 flex items-center justify-between rounded-lg border border-[var(--oz-border)] bg-[var(--oz-surface)] px-3 py-2.5">
          <Link href="/" className="flex items-center gap-2" aria-label="back to sessions">
            <PixelIcon name="arrow-left" size={14} />
            <h1 className="text-base font-bold uppercase tracking-[0.1em]">artifacts</h1>
          </Link>
          {unread > 0 && (
            <button
              onClick={() => {
                markAllSeen(files);
                touch();
              }}
              className="rounded border border-[var(--oz-border)] px-2.5 py-1.5 text-[10px] text-[var(--oz-dim)] hover:text-[var(--oz-text)]"
            >
              mark all read
            </button>
          )}
        </header>

        <div className="mb-1.5 flex items-center gap-1.5">
          {(['html', 'all'] as const).map((f) => {
            const active = filter === f;
            const n = f === 'html' ? countUnseen(files.filter(isHtml)) : countUnseen(files);
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={active}
                className={`rounded border bg-[var(--oz-surface)] px-3 py-1.5 text-xs ${
                  active
                    ? 'border-[var(--oz-active)]/55 text-[var(--oz-active)]'
                    : 'border-[var(--oz-border)] text-[var(--oz-dim)] hover:text-[var(--oz-text)]'
                }`}
              >
                {f}
                {n > 0 && (
                  <span className="text-[10px] text-[var(--oz-active)]">{' '}{n}</span>
                )}
              </button>
            );
          })}
          <span className="ml-auto text-[10px] text-[var(--oz-dim)]">
            {viewRows.length} shown · {unread} unseen
          </span>
        </div>

        {open ? (
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setOpen(null)}
              className="flex w-fit items-center gap-1.5 rounded border border-[var(--oz-border)] px-2.5 py-1.5 text-xs text-[var(--oz-dim)]"
            >
              <PixelIcon name="arrow-left" size={10} /> back to list
            </button>
            <div className="truncate px-1 text-xs text-[var(--oz-dim)]">
              {open.name} · {fmtTime(open.mtime)} · {fmtSize(open.size)}
            </div>
            <Viewer file={open} />
          </div>
        ) : viewRows.length === 0 ? (
          <div className="pt-6 text-center text-xs text-[var(--oz-dim)]">{emptyMsg}</div>
        ) : filter === 'html' ? (
          /* thumbnail cards — the design mockups speak for themselves */
          <div className="grid grid-cols-2 gap-2" data-testid="artifact-grid">
            {viewRows.map(({ f, isUnread }) => (
              <div key={f.name} className="relative">
                <button
                  onClick={() => openArtifact(f)}
                  aria-label={f.name}
                  className={`oz-row w-full overflow-hidden rounded border bg-[var(--oz-surface)] text-left ${
                    isUnread ? 'border-[var(--oz-active)]/45' : 'border-[var(--oz-border)]'
                  }`}
                >
                  <HtmlThumb name={f.name} />
                  <div className="flex items-center gap-1.5 px-2 py-1.5">
                    <span
                      className="h-[7px] w-[7px] shrink-0 rounded-full"
                      style={{ background: isUnread ? 'var(--oz-active)' : 'transparent' }}
                    />
                    <span
                      className={`truncate text-xs ${isUnread ? 'font-bold' : 'text-[var(--oz-text)]/80'}`}
                    >
                      {f.name}
                    </span>
                  </div>
                </button>
                {/* both entries possible: tap = here, corner = new tab. Sibling
                    overlay — nested buttons are invalid and break the tap */}
                <button
                  onClick={() => {
                    markSeen(f.name, f.mtime);
                    touch();
                    window.open(
                      `/artifacts/view/${encodeURIComponent(f.name)}`,
                      '_blank',
                      'noopener'
                    );
                  }}
                  aria-label={`open ${f.name} in new tab`}
                  className="absolute right-1.5 top-1.5 z-10 rounded border border-[var(--oz-border)] bg-[var(--oz-surface)]/90 p-1 text-[var(--oz-dim)]"
                >
                  <PixelIcon name="external" size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="artifact-list">
            {(() => {
              const out: React.ReactNode[] = [];
              let day = '';
              viewRows.forEach(({ f, isUnread }, i) => {
                const d = dayLabel(f.mtime);
                if (d !== day) {
                  day = d;
                  out.push(
                    <li
                      key={`day-${i}`}
                      className="mb-0.5 mt-2.5 px-0.5 text-[10px] uppercase tracking-[0.14em] text-[var(--oz-dim)] first:mt-0.5"
                    >
                      {d}
                    </li>
                  );
                }
                out.push(
                  <li key={f.name}>
                    <button
                      onClick={() => openArtifact(f)}
                      className={`oz-row flex w-full items-center gap-2.5 rounded border bg-[var(--oz-surface)] px-3 py-2.5 text-left text-sm ${
                        isUnread
                          ? 'border-[var(--oz-active)]/45'
                          : 'border-[var(--oz-border)] text-[var(--oz-text)]/80'
                      }`}
                    >
                      <span
                        className="h-[7px] w-[7px] shrink-0 rounded-full"
                        style={{ background: isUnread ? 'var(--oz-active)' : 'transparent' }}
                      />
                      <span
                        className={`w-5 shrink-0 text-center ${
                          isUnread ? 'text-[var(--oz-active)]' : 'text-[var(--oz-dim)]'
                        }`}
                      >
                        {glyphOf(f.name)}
                      </span>
                      <span className={`truncate ${isUnread ? 'font-bold' : ''}`}>{f.name}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--oz-dim)]">
                        {fmtTime(f.mtime)} · {fmtSize(f.size)}
                      </span>
                    </button>
                  </li>
                );
              });
              return out;
            })()}
          </ul>
        )}
      </main>
    </>
  );
}

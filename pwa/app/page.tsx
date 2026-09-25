'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PixelIcon } from '@/components/pixel-icon';
import { askedSessions, clearAsked, notifyReply } from '@/lib/notify';
import { lastRead, markRead } from '@/lib/read';
import { slugify } from '@/lib/slug';

type Sess = {
  id: string;
  title: string;
  preview: string;
  updated: number;
  lastRole?: string;
  lastAt?: number;
  lastHasQ?: boolean;
  pending?: boolean;
};

/** Mobile-style swipe row: drag left to reveal a red delete zone; release
 *  past the threshold to delete, else it snaps back. A tap still opens. */
function SwipeRow({
  onOpen,
  onDelete,
  children,
}: {
  onOpen: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const x0 = useRef(0);
  const moved = useRef(false);

  return (
    <div className="relative overflow-hidden rounded">
      <div className="absolute inset-y-0 right-0 flex w-24 items-center justify-center rounded bg-[var(--oz-danger)]/80 text-white">
        <PixelIcon name="trash" size={16} />
      </div>
      <button
        onClick={() => {
          if (!moved.current) onOpen();
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary) return;
          x0.current = e.clientX;
          moved.current = false;
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          const d = Math.min(0, e.clientX - x0.current);
          if (d < -6) moved.current = true;
          setDx(Math.max(-96, d));
        }}
        onPointerUp={() => {
          setDragging(false);
          if (dx < -64) onDelete();
          else setDx(0);
        }}
        onPointerCancel={() => {
          setDragging(false);
          setDx(0);
        }}
        onPointerLeave={() => {
          if (dragging) {
            setDragging(false);
            setDx(0);
          }
        }}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 150ms ease-out',
          touchAction: 'pan-y',
        }}
        className="oz-row relative w-full rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] px-3 py-2 text-left"
      >
        {children}
      </button>
    </div>
  );
}

export default function SessionsPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const loadInFlightRef = useRef(false);
  // undo window: row vanishes instantly, but the DELETE only fires when the
  // 3s toast expires (or on unmount — entering a session commits it)
  const [toast, setToast] = useState<{ s: Sess; key: number } | null>(null);
  const pendingRef = useRef<{ s: Sess; timer: ReturnType<typeof setTimeout> } | null>(null);

  const load = useCallback(async () => {
    // backgrounded mobile tabs freeze in-flight polls for minutes and then
    // fail on resume — bound each request, never overlap, never throw
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setLoading(true);
    try {
      const r = await fetch('/api/session', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      const list: Sess[] = await r.json();
      // hide rows sitting in an undo window — the server still has them
      setSessions(list.filter((x) => x.id !== pendingRef.current?.s.id));
      // first run after this feature shipped: treat everything currently in
      // the list as read — a wall of unread dots helps nobody
      if (!localStorage.getItem('oz-read-init')) {
        for (const s of list) markRead(slugify(s.title || s.id), s.lastAt || 0);
        localStorage.setItem('oz-read-init', '1');
      }
      // sessions the user asked a question in: when a reply lands, it's
      // their turn again — notify (even from the background). pending=false
      // proves the run actually finished (mid-run steps also end in an
      // assistant message)
      for (const s of list) {
        const slug = slugify(s.title || s.id);
        if (!askedSessions().includes(slug)) continue;
        if (s.lastRole === 'assistant' && !s.pending) {
          clearAsked(slug);
          void notifyReply(slug);
        }
      }
    } catch {
      /* transient — keep showing the stale list */
    } finally {
      loadInFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // background watcher for "my turn" across sessions
    const t = setInterval(() => {
      if (document.hidden) void load();
    }, 8000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  async function create() {
    const title = name.trim() || `session ${new Date().toLocaleString()}`;
    const r = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: title }),
    });
    const s = await r.json();
    if (s.id) router.push(`/session/${slugify(s.title)}?id=${s.id}`);
    setCreating(false);
    setName('');
  }

  function fireDelete(id: string) {
    void fetch(`/api/session/${id}`, { method: 'DELETE' }).catch(() => void load());
  }

  function commitPending() {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    setToast(null);
    fireDelete(p.s.id);
  }

  function remove(s: Sess) {
    commitPending(); // a new delete supersedes an older undo window
    setSessions((list) => list.filter((x) => x.id !== s.id)); // optimistic
    pendingRef.current = { s, timer: setTimeout(commitPending, 3000) };
    setToast({ s, key: Date.now() });
  }

  function undo() {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    setToast(null);
    setSessions((list) => [...list, p.s]); // sort re-places it
  }

  // navigating away (opening a session) mid-window still counts as deleted
  useEffect(
    () => () => {
      const p = pendingRef.current;
      if (p) {
        clearTimeout(p.timer);
        void fetch(`/api/session/${p.s.id}`, { method: 'DELETE' }).catch(() => {});
      }
    },
    []
  );

  return (
    <>
      <div aria-hidden="true" className="oz-ygg-bg" />
      <main className="relative z-[1] mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
        <header className="mt-4 mb-2 flex items-center justify-between rounded-lg border border-[var(--oz-border)] bg-[var(--oz-surface)] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <svg
              viewBox="0 0 16 16"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M3 1v14M3 2l7 3-7 3M3 8l7 3-7 3" />
            </svg>
            <h1 className="text-base font-bold tracking-[0.1em] uppercase">Bifrost</h1>
          </div>
          <button
            onClick={load}
            className="rounded-md border border-[var(--oz-border)] px-3 py-1.5 text-xs text-[var(--oz-dim)] hover:text-white"
          >
            {loading ? '···' : 'refresh'}
          </button>
        </header>

        <button
          onClick={() => setCreating(true)}
          className="oz-row mb-2 flex items-center gap-2 rounded border border-[var(--oz-success)]/60 bg-[var(--oz-surface)] px-3 py-3 text-left text-sm text-[var(--oz-success)]"
        >
          <PixelIcon name="plus" size={14} /> new session
        </button>

        {creating && (
          <div className="mb-2 rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] p-3">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder="session name…"
              className="w-full bg-transparent pb-3 text-sm outline-none placeholder:text-[var(--oz-dim)]"
            />
            <div className="flex gap-2 text-xs">
              <button
                onClick={create}
                className="flex-1 rounded border border-[var(--oz-success)]/60 py-2 text-[var(--oz-success)]"
              >
                create & open
              </button>
              <button
                onClick={() => setCreating(false)}
                className="rounded border border-[var(--oz-border)] px-4 py-2 text-[var(--oz-dim)]"
              >
                cancel
              </button>
            </div>
          </div>
        )}

        <ul className="flex flex-col gap-1">
          {[...sessions]
            .map((s) => {
              const unread =
                s.lastRole === 'assistant' && (s.lastAt || 0) > lastRead(slugify(s.title || s.id));
              // opened & caught up, but the agent's last message still asks
              // something and no reply followed (lastRole is still
              // 'assistant') → "open question" badge in a second color.
              // lastHasQ is computed server-side on the FULL message text —
              // the 80-char preview usually ends before the questions do
              const openQ = s.lastRole === 'assistant' && !s.pending && !unread && !!s.lastHasQ;
              return { s, unread, openQ };
            })
            .sort(
              (a, b) =>
                // dot tiers first (pending ●, unread ●, open question ●),
                // each tier latest-first, then everything else latest-first
                Number(!!b.s.pending) - Number(!!a.s.pending) ||
                Number(b.unread) - Number(a.unread) ||
                Number(b.openQ) - Number(a.openQ) ||
                (b.s.updated || b.s.lastAt || 0) - (a.s.updated || a.s.lastAt || 0)
            )
            .map(({ s, unread, openQ }) => (
              <li key={s.id}>
                <SwipeRow
                  onOpen={() => router.push(`/session/${slugify(s.title)}?id=${s.id}`)}
                  onDelete={() => remove(s)}
                >
                  <div className="flex items-center gap-1.5">
                    {s.pending && <span className="oz-busy text-[var(--oz-active)]">●</span>}
                    {unread && !s.pending && <span className="text-[var(--oz-active)]">●</span>}
                    {openQ && <span className="text-[var(--oz-info)]">●</span>}
                    <div className={`truncate text-sm ${unread ? 'font-bold' : ''}`}>
                      {s.title || s.id}
                    </div>
                  </div>
                  <div
                    className={`truncate text-xs ${unread ? 'text-white/80' : 'text-[var(--oz-dim)]'}`}
                  >
                    {s.pending ? 'awaiting answer…' : s.preview || '\u00a0'}
                  </div>
                </SwipeRow>
              </li>
            ))}
        </ul>
      </main>

      {/* undo toast — bar mirrors the 3s window; tap undo to restore the row */}
      {toast && (
        <div
          key={toast.key}
          className="fixed inset-x-3 bottom-4 z-50 mx-auto flex max-w-md items-center gap-3 overflow-hidden rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] px-4 py-3 shadow-lg"
        >
          <div className="min-w-0 flex-1 truncate text-xs text-[var(--oz-dim)]">
            deleted “{toast.s.title || toast.s.id}”
          </div>
          <button
            onClick={undo}
            className="shrink-0 rounded border border-[var(--oz-success)]/60 px-3 py-1.5 text-xs text-[var(--oz-success)]"
          >
            undo
          </button>
          <div className="absolute inset-x-0 bottom-0 h-0.5">
            <div className="oz-toast-bar h-full bg-[var(--oz-success)]/70" />
          </div>
        </div>
      )}
    </>
  );
}

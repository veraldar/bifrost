'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LineIcon } from '@/components/line-icon';
import { BAND_VIEWBOX, YggTree } from '@/components/ygg';
import { Marked } from '@/components/marked';
import { askedSessions, clearAsked, notifyReply } from '@/lib/notify';
import type { ArtifactEntry } from '@/lib/artifacts';
import { countUnseen, seenInit } from '@/lib/artifact-read';
import { lastRead, markRead } from '@/lib/read';
import { slugify } from '@/lib/slug';

// open-question circles go stale after this long
const OPEN_QUESTION_TTL_MS = 48 * 60 * 60 * 1000;

type Sess = {
  id: string;
  title: string;
  // set on sub-sessions: the session that spawned them (via an agent task).
  // Children never sort the list themselves — they nest under their parent
  parentId?: string | null;
  preview: string;
  updated: number;
  lastRole?: string;
  lastAt?: number;
  lastHasQ?: boolean;
  msgs?: number;
  pending?: boolean;
};

type GHit = {
  id: string;
  title: string;
  hits: number;
  lastHit: number;
  snippets: { role: string; time: number; text: string }[];
};

/** Mobile-style swipe row: drag left to reveal a red delete zone; release
 *  past the threshold to delete, else it snaps back. A tap still opens. */
function SwipeRow({
  onOpen,
  onDelete,
  compact,
  unread,
  children,
}: {
  onOpen: () => void;
  onDelete: () => void;
  compact?: boolean;
  unread?: boolean;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const x0 = useRef(0);
  const moved = useRef(false);
  const captured = useRef(false);

  return (
    <div className="oz-sw">
      <div className="oz-zone" aria-hidden="true">
        delete
      </div>
      <button
        onClick={() => {
          if (!moved.current) onOpen();
        }}
        onPointerDown={(e) => {
          if (!e.isPrimary) return;
          x0.current = e.clientX;
          moved.current = false;
          captured.current = false;
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          const d = Math.min(0, e.clientX - x0.current);
          if (d < -6) {
            // capture only once horizontal drag intent is clear — a capture
            // on pointerdown would retarget taps to the row and break inner
            // click targets (the subs pill); once captured, the drag survives
            // crossing the row/screen edge instead of dying in pointerleave
            if (!captured.current) {
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* pointer may be gone — drag continues best-effort */
              }
              captured.current = true;
            }
            moved.current = true;
          }
          setDx(Math.max(-96, d));
        }}
        onPointerUp={() => {
          setDragging(false);
          captured.current = false;
          if (dx < -64) onDelete();
          else setDx(0);
        }}
        onPointerCancel={() => {
          setDragging(false);
          captured.current = false;
          setDx(0);
        }}
        onPointerLeave={() => {
          if (dragging && !captured.current) {
            setDragging(false);
            setDx(0);
          }
        }}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 150ms ease-out',
          touchAction: 'pan-y',
        }}
        className={`oz-row ${compact ? 'compact' : ''} ${unread ? 'unread' : ''}`}
      >
        {children}
      </button>
    </div>
  );
}

/** Compact row stamp: clock time for today, short date for older — Discord style. */
function fmtListTime(t?: number): string {
  if (!t) return '';
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function SessionsPage() {
  const router = useRouter();
  // instant paint on back-navigation: the last fetched list is cached in
  // sessionStorage (per-tab), so the rows are there before the first fetch
  // answers — the fresh fetch then updates/corrects underneath
  const [sessions, setSessions] = useState<Sess[]>(() => {
    try {
      const raw = sessionStorage.getItem('oz-sessions');
      return raw ? (JSON.parse(raw) as Sess[]) : [];
    } catch {
      return [];
    }
  });
  // artifacts the agents left unseen — drives the header bell badge;
  // counted on the same load/poll cycle as the session list
  const [unseenArts, setUnseenArts] = useState(0);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const loadInFlightRef = useRef(false);
  // undo window: row (and its sub-tree) vanishes instantly, but the DELETE
  // only fires when the toast expires (or on unmount — entering a session
  // commits it). opencode cascades deletes server-side, so the family is
  // stashed here to hide + restore atomically. Mercy scales with content:
  // a session holding ≥10 msgs gets 10s to be saved, not 3
  const UNDO_MS = 3000;
  const UNDO_MS_HEAVY = 10_000;
  const [toast, setToast] = useState<{
    s: Sess;
    famCount: number;
    win: number;
    key: number;
  } | null>(null);
  const pendingRef = useRef<{ s: Sess; fam: Sess[]; timer: ReturnType<typeof setTimeout> } | null>(
    null
  );

  // sub-sessions group under their parent at render time; the parent list's
  // sort order is untouched. Children whose parent is gone (deleted) fall
  // back to the top level — nothing silently disappears from the list
  const kidsById = useMemo(() => {
    const m = new Map<string, Sess[]>();
    for (const s of sessions) {
      if (!s.parentId) continue;
      const arr = m.get(s.parentId);
      if (arr) arr.push(s);
      else m.set(s.parentId, [s]);
    }
    for (const arr of m.values())
      arr.sort((a, b) => (b.updated || b.lastAt || 0) - (a.updated || a.lastAt || 0));
    return m;
  }, [sessions]);
  const knownIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  const roots = useMemo(
    () => sessions.filter((s) => !s.parentId || !knownIds.has(s.parentId)),
    [sessions, knownIds]
  );

  // which parents have their sub-tree expanded — per-tab persistence so
  // back-navigation doesn't collapse what you opened
  const [subsOpen, setSubsOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('oz-subs-open') || '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  function toggleSubs(id: string) {
    setSubsOpen((o) => {
      const next = { ...o, [id]: !o[id] };
      try {
        sessionStorage.setItem('oz-subs-open', JSON.stringify(next));
      } catch {
        /* quota — skip cache */
      }
      return next;
    });
  }

  // global transcript search — lives on home because "where did I talk about
  // X?" starts from the session list; results replace the list while active
  const [gOpen, setGOpen] = useState(false);
  const [gq, setGq] = useState('');
  const [gHits, setGHits] = useState<GHit[] | null>(null);
  const [gBusy, setGBusy] = useState(false);
  // one live search at a time: a newer keystroke ABORTS the in-flight query
  // instead of being dropped — the old guard swallowed everything typed while
  // a slow (50-session fan-out) search ran, leaving results for "y" showing
  // under an input that said "yggdrasil"
  const gAbort = useRef<AbortController | null>(null);
  const gqRef = useRef('');

  useEffect(() => {
    const q = gq.trim();
    gqRef.current = q;
    // 1-char queries scan every session for noise — don't fire them
    if (!gOpen || q.length < 2) {
      setGHits(null);
      return;
    }
    const t = setTimeout(() => {
      gAbort.current?.abort();
      const ctrl = new AbortController();
      gAbort.current = ctrl;
      setGBusy(true);
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => {
          if (gqRef.current === q) setGHits(d.sessions || []);
        })
        .catch(() => {
          if (!ctrl.signal.aborted && gqRef.current === q) setGHits([]);
        })
        .finally(() => {
          if (gAbort.current === ctrl) setGBusy(false);
        });
    }, 350);
    return () => clearTimeout(t);
  }, [gq, gOpen]);

  const load = useCallback(async () => {
    // backgrounded mobile tabs freeze in-flight polls for minutes and then
    // fail on resume — bound each request, never overlap, never throw
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setLoading(true);
    // artifact count rides along in parallel — its failure never touches
    // the session list
    const artsP = fetch('/api/artifact', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json() as Promise<ArtifactEntry[]>)
      .catch(() => null);
    try {
      const r = await fetch('/api/session', {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      const list: Sess[] = await r.json();
      // hide rows sitting in an undo window — the server still has the
      // whole family until the toast expires
      const p = pendingRef.current;
      const hideIds = p ? new Set([p.s.id, ...p.fam.map((x) => x.id)]) : null;
      const visible = list.filter((x) => !hideIds || !hideIds.has(x.id));
      setSessions(visible);
      try {
        sessionStorage.setItem('oz-sessions', JSON.stringify(visible));
      } catch {
        /* quota — skip cache */
      }
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
    // first run after this feature ships: everything already on disk counts
    // as seen — a bell opening at "167" helps nobody
    const arts = await artsP;
    if (arts) {
      seenInit(arts);
      setUnseenArts(countUnseen(arts));
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
    // opencode cascades the delete server-side — collect the whole sub-tree
    // so orphaned sub-rows never linger at the top level
    const fam: Sess[] = [];
    const frontier = [s.id];
    while (frontier.length) {
      const id = frontier.pop() as string;
      for (const k of kidsById.get(id) || []) {
        fam.push(k);
        frontier.push(k.id);
      }
    }
    const famIds = new Set(fam.map((x) => x.id));
    setSessions((list) => list.filter((x) => x.id !== s.id && !famIds.has(x.id))); // optimistic
    const win = (s.msgs || 0) + fam.reduce((n, x) => n + (x.msgs || 0), 0) >= 10
      ? UNDO_MS_HEAVY
      : UNDO_MS;
    pendingRef.current = { s, fam, timer: setTimeout(commitPending, win) };
    setToast({ s, famCount: fam.length, win, key: Date.now() });
  }

  function undo() {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    setToast(null);
    setSessions((list) => [...list, p.s, ...p.fam]); // sort re-places them
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

  // the band walks only while something is true: any run (sub-runs too)
  const working = sessions.filter((s) => s.pending).length;

  return (
    <>
      <main className="relative mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
        {/* the wordmark alone, full caps, no sign before it — it is the way
            into settings; the artifact runestone counts what you haven't seen */}
        <header className="oz-head">
          <Link href="/settings" className="oz-brand" aria-label="BIFROST — settings">
            <h1 className="oz-brand">BIFROST</h1>
          </Link>
          <div className="flex items-center gap-1.5">
            <Link
              href="/artifacts"
              aria-label={`artifacts — ${unseenArts} unseen`}
              className={`oz-k sm ${unseenArts > 0 ? 'text-[var(--oz-text)]' : ''}`}
            >
              <LineIcon name="artifact" size={15} />
              {unseenArts > 0 && (
                <span data-testid="artifact-badge" className="oz-badge">
                  {unseenArts}
                </span>
              )}
            </Link>
            <button
              onClick={load}
              aria-label="refresh sessions"
              className={`oz-k sm ${loading ? 'ok' : ''}`}
            >
              {loading ? '…' : 'refresh'}
            </button>
          </div>
        </header>

        {/* the tree, once, as a quiet band — one thought walks it at a time
            while something works; it falls still when nothing does */}
        <figure
          className={`oz-band oz-ygg -mx-3 mb-2.5 ${working ? 'live' : ''}`}
          aria-label={working ? `your box — ${working} working` : 'your box — nothing working'}
        >
          <YggTree viewBox={BAND_VIEWBOX} slice />
          <figcaption className="oz-cap">
            <i />
            {working ? `${working} working` : 'all quiet'}
          </figcaption>
        </figure>

        <div className="mb-2 flex items-stretch gap-1.5">
          <button
            onClick={() => setCreating(true)}
            className="oz-k ok h-11 flex-1 justify-start px-3 text-[13px]"
          >
            <LineIcon name="plus" size={14} /> new session
          </button>
          {!gOpen && (
            <button
              aria-label="search all sessions"
              onClick={() => setGOpen(true)}
              className="oz-k h-11 w-11"
            >
              <LineIcon name="search" size={14} />
            </button>
          )}
        </div>

        {creating && (
          <div className="oz-box mb-2 p-3">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder="session name…"
              className="oz-field mb-2.5"
            />
            <div className="flex gap-1.5">
              <button onClick={create} className="oz-k ok flex-1">
                create & open
              </button>
              <button onClick={() => setCreating(false)} className="oz-k px-4">
                cancel
              </button>
            </div>
          </div>
        )}

        {/* global search — expands from the search key into the query field */}
        {gOpen && (
          <div className="oz-box mb-2 flex items-center gap-2 px-3 py-2">
            <LineIcon name="search" size={14} className="text-[var(--oz-dim)]" />
            <input
              autoFocus
              value={gq}
              onChange={(e) => setGq(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setGOpen(false);
                  setGq('');
                  e.currentTarget.blur();
                }
              }}
              placeholder="search all sessions…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--oz-dim)]"
              style={{ caretColor: 'var(--oz-active)' }}
            />
            {gBusy && <span className="text-[10px] text-[var(--oz-dim)]">···</span>}
            <button
              aria-label="close global search"
              onClick={() => {
                setGOpen(false);
                setGq('');
              }}
              className="text-[var(--oz-dim)] hover:text-[var(--oz-text)]"
            >
              <LineIcon name="close" size={12} />
            </button>
          </div>
        )}

        {gOpen && gq.trim() ? (
          /* results replace the list: grouped per session, newest match first */
          gHits && gHits.length === 0 ? (
            <div className="pt-6 text-center text-xs text-[var(--oz-dim)]">no hits</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {(gHits || []).map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() =>
                      router.push(
                        `/session/${slugify(h.title)}?id=${h.id}&q=${encodeURIComponent(gq.trim())}`
                      )
                    }
                    className="oz-row"
                  >
                    <div className="oz-r1">
                      <span className="t">{h.title}</span>
                      <time>
                        {fmtListTime(h.lastHit)} · {h.hits} hit{h.hits === 1 ? '' : 's'}
                      </time>
                    </div>
                    {h.snippets.map((sn, i) => (
                      <div key={i} className={`oz-r2 ${i === 0 ? '' : 'opacity-70'}`}>
                        <span className="text-[10px]">({sn.role === 'assistant' ? 'agent' : sn.role}) </span>
                        <Marked text={sn.text} q={gq} />
                      </div>
                    ))}
                  </button>
                </li>
              ))}
              {gBusy && !gHits && (
                <li className="pt-6 text-center text-xs text-[var(--oz-dim)]">searching…</li>
              )}
            </ul>
          )
        ) : (
          <ul className="flex flex-col gap-1">
          {[...roots]
            .map((s) => {
              const unread =
                s.lastRole === 'assistant' && (s.lastAt || 0) > lastRead(slugify(s.title || s.id));
              // last assistant message still asks something and no reply
              // followed (lastRole is still 'assistant') → outlined circle.
              // Read or unread both count; it decays after 48h so dead
              // questions don't linger forever, and it never reorders the
              // list. lastHasQ is computed server-side on the FULL message
              // text — the 80-char preview usually ends before the questions do
              const openQ =
                s.lastRole === 'assistant' &&
                !s.pending &&
                !!s.lastHasQ &&
                Date.now() - (s.lastAt || 0) < OPEN_QUESTION_TTL_MS;
              return { s, unread, openQ };
            })
            .sort(
              (a, b) =>
                // pending (live runs) and unread float to the top, each
                // latest-first; question circles are a hint only — they never
                // reorder the list, recency decides everything else
                Number(!!b.s.pending) - Number(!!a.s.pending) ||
                Number(b.unread) - Number(a.unread) ||
                (b.s.updated || b.s.lastAt || 0) - (a.s.updated || a.s.lastAt || 0)
            )
            .map(({ s, unread, openQ }) => {
              const kids = kidsById.get(s.id) || [];
              const anyKidLive = kids.some((k) => k.pending);
              return (
                <li key={s.id}>
                  <SwipeRow
                    unread={unread}
                    onOpen={() => router.push(`/session/${slugify(s.title)}?id=${s.id}`)}
                    onDelete={() => remove(s)}
                  >
                    {/* state law: working is green and breathes, unread is
                        weight + a text-colored dot, the open question rings ○ */}
                    <div className="oz-r1">
                      {s.pending && (
                        <span className="oz-breathe text-[var(--oz-success)]" aria-label="working">
                          ●
                        </span>
                      )}
                      {!s.pending && openQ && <span aria-label="open question">○</span>}
                      {!s.pending && unread && !openQ && <span aria-label="unread">●</span>}
                      <span className="t">{s.title || s.id}</span>
                      {kids.length > 0 && (
                        // tap target for the sub-tree only — the row itself
                        // still opens the session; a live sub shows green so
                        // activity is visible even while collapsed
                        <span
                          role="button"
                          aria-expanded={!!subsOpen[s.id]}
                          aria-label={`${kids.length} sub-session${kids.length === 1 ? '' : 's'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSubs(s.id);
                          }}
                          className={`oz-subs ${
                            subsOpen[s.id] ? 'open' : anyKidLive ? 'live' : ''
                          }`}
                        >
                          {kids.length} sub{kids.length === 1 ? '' : 's'}
                          {anyKidLive && !subsOpen[s.id] ? ' ●' : ''}
                        </span>
                      )}
                      <time>{fmtListTime(s.updated || s.lastAt)}</time>
                    </div>
                    <div className="oz-r2">
                      {s.pending ? 'awaiting answer…' : s.preview || '\u00a0'}
                    </div>
                  </SwipeRow>
                  {kids.length > 0 && subsOpen[s.id] && (
                    <div className="oz-kids">
                      {kids.map((k) => {
                        const kUnread =
                          k.lastRole === 'assistant' &&
                          (k.lastAt || 0) > lastRead(slugify(k.title || k.id));
                        return (
                          // same swipe-left-to-delete as top-level rows — a
                          // sub dies alone (no cascade: it has no sub-tree)
                          <SwipeRow
                            key={k.id}
                            compact
                            unread={kUnread}
                            onOpen={() =>
                              router.push(`/session/${slugify(k.title || k.id)}?id=${k.id}`)
                            }
                            onDelete={() => remove(k)}
                          >
                            <div className="oz-r1">
                              {k.pending && (
                                <span
                                  className="oz-breathe text-[10px] text-[var(--oz-success)]"
                                  aria-label="working"
                                >
                                  ●
                                </span>
                              )}
                              {!k.pending && kUnread && (
                                <span className="text-[10px]" aria-label="unread">
                                  ●
                                </span>
                              )}
                              <span className="t opacity-85">{k.title || k.id}</span>
                              <time>{fmtListTime(k.updated || k.lastAt)}</time>
                            </div>
                            {(k.pending ? 'awaiting answer…' : k.preview) && (
                              <div className="oz-r2">
                                {k.pending ? 'awaiting answer…' : k.preview}
                              </div>
                            )}
                          </SwipeRow>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {/* undo toast — the bar is the mercy window; tap undo to restore the row */}
      {toast && (
        <div
          key={toast.key}
          role="status"
          className="oz-toast fixed inset-x-3 bottom-4 z-50 mx-auto max-w-md"
        >
          {/* what you just removed — msg count makes a heavy delete visible
              while the (longer) mercy window is still open */}
          <div className="msg">
            deleted “{toast.s.title || toast.s.id}”
            {(toast.s.msgs || 0) > 0 && ` · ${toast.s.msgs} msgs`}
            {toast.famCount > 0 &&
              ` + ${toast.famCount} sub${toast.famCount === 1 ? '' : 's'}`}
          </div>
          <button onClick={undo} className="oz-k sm ok">
            undo
          </button>
          <span className="oz-toast-bar" style={{ animationDuration: `${toast.win}ms` }} />
        </div>
      )}
    </>
  );
}

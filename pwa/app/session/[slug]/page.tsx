'use client';

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useRouter } from 'next/navigation';
import { Room, RoomEvent, Track, createAudioAnalyser } from 'livekit-client';
import Link from 'next/link';
import { PixelIcon } from '@/components/pixel-icon';
import { type Msg, SessionMessage, userProse } from '@/components/session-message';
import { MessageHistory } from '@/components/message-history';
import { useSwipeX } from '@/lib/use-swipe-x';
import { ErrorBox } from '@/components/app/error-box';
import {
  getSpeech,
  pauseSpeech,
  rateSpeech,
  resumeSpeech,
  seekSpeech,
  startSpeech,
  stopSpeech,
  subscribeSpeech,
} from '@/lib/speech';
import { diagEvent } from '@/lib/diag';
import { clearAsked, ensureNotifyPermission, markAsked, notifyReply } from '@/lib/notify';
import { PENDING_TTL_MS } from '@/lib/pending-ttl';
import { markRead } from '@/lib/read';
import { lastHeard, markHeard } from '@/lib/heard';

type Mode = 'text' | 'free';
type Attach =
  | { kind: 'image'; name: string; dataUrl: string }
  | { kind: 'file'; name: string; content: string };

const PTT_BARS = 5;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} timeout (${ms / 1000}s)`)), ms)
    ),
  ]);
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

/** The voice agent can lag the room join (fresh dispatch after a page
 *  reload or a teardown): poll briefly instead of dropping the turn — a
 *  commit fired while `remoteParticipants` is still empty reaches nobody
 *  and the hold is lost silently (req 09-29 'switching from hand free to
 *  keyboard and then using the push to talk is not working'). */
async function agentInRoom(room: Room, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const agent = Array.from(room.remoteParticipants.values())[0];
    if (agent) return agent;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Live mic equalizer — 5 voice-band bars (100Hz–2kHz) from the published
 *  mic track's FFT. Shared by the PTT hold pill and the hands-free strip;
 *  the track may not exist yet (dial still in progress), so poll for it and
 *  attach the analyser the moment it goes live. */
function useMicLevels(active: boolean, roomRef: RefObject<Room | null>) {
  const [levels, setLevels] = useState<number[]>(() => Array(PTT_BARS).fill(0));
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let raf = 0;
    const tick = (
      analyser: AnalyserNode,
      bins: Uint8Array<ArrayBuffer>,
      lo: number,
      width: number
    ) => {
      analyser.getByteFrequencyData(bins);
      setLevels(
        Array.from({ length: PTT_BARS }, (_, i) => {
          let sum = 0;
          const end = Math.min(lo + (i + 1) * width, bins.length);
          let n = 0;
          for (let b = lo + i * width; b < end; b++, n++) sum += bins[b];
          return Math.min(1, (n ? sum / n : 0) / 255) * 2.2;
        })
      );
      raf = requestAnimationFrame(() => tick(analyser, bins, lo, width));
    };
    const findTrack = setInterval(() => {
      if (cancelled) return;
      const room = roomRef.current;
      const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (!room || !pub?.audioTrack) return;
      clearInterval(findTrack);
      const { analyser } = createAudioAnalyser(pub.audioTrack);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const nyquist = analyser.context.sampleRate / 2;
      const binOf = (hz: number) =>
        Math.min(bins.length - 1, Math.round((hz / nyquist) * bins.length));
      const lo = binOf(100);
      const hi = Math.max(lo + PTT_BARS, binOf(2000));
      const width = Math.max(1, Math.floor((hi - lo + 1) / PTT_BARS));
      tick(analyser, bins, lo, width);
    }, 100);
    return () => {
      cancelled = true;
      clearInterval(findTrack);
      cancelAnimationFrame(raf);
    };
  }, [active, roomRef]);
  return levels;
}

/** Downscale to max 1568px and re-encode JPEG unless it's already small. */
async function downscaleImage(f: File): Promise<string> {
  const MAX = 1568;
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    if (scale === 1 && f.size < 300_000) {
      bmp.close?.();
      return await fileToDataUrl(f);
    }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.85);
  } catch {
    return await fileToDataUrl(f);
  }
}

export default function SessionView({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ id?: string; q?: string }>;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  // tts deck store (speak-last-reply dock) + seek-bar drag state
  const speech = useSyncExternalStore(subscribeSpeech, getSpeech);
  const [seekFrac, setSeekFrac] = useState<number | null>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  // swipe-history browser: index of the message on screen, null = closed
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('text');
  const [busy, setBusy] = useState(false);
  const [busySecs, setBusySecs] = useState(0);
  const [holding, setHolding] = useState(false);
  const [pttSecs, setPttSecs] = useState(0);
  const [voiceState, setVoiceState] = useState<'off' | 'connecting' | 'ready'>('off');
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<Attach[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(60);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // transcript search — an overlay, NOT a mode: text/hands-free keep running
  // underneath; the bar filters nothing, it rings matches and jumps between them
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchOpen || !q) return [];
    const out: number[] = [];
    msgs.forEach((m, i) => {
      if (m.text.toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [searchOpen, query, msgs]);
  // modulo-wrap so ↓ at the last match lands back on the first
  const safeIdx = matches.length
    ? ((matchIdx % matches.length) + matches.length) % matches.length
    : 0;
  const hitSet = useMemo(() => new Set(matches), [matches]);
  // jump to the active match whenever it changes — search scrolls free of
  // the bottom-stick logic. A deep link from global search (?q=…) lands on
  // the NEWEST match instead: "pick up work" means freshest context first
  const jumpNewestRef = useRef(false);
  // Tall messages (pasted dumps) center badly with scrollIntoView — the top,
  // where the match usually sits, ends up off-screen. Scroll to the first
  // <mark> inside when there is one (exact keyword, centered); otherwise pin
  // the message top below header+search bar (scroll-mt-24 on the root)
  const jumpTo = (mi: number) => {
    const el = document.querySelector(`[data-mi="${mi}"]`);
    if (!el) return;
    const mark = el.querySelector('mark');
    (mark ?? el).scrollIntoView({ block: mark ? 'center' : 'start', behavior: 'smooth' });
  };
  useEffect(() => {
    if (!matches.length) return;
    if (jumpNewestRef.current) {
      // deep link: land on the NEWEST match. Must scroll HERE — setMatchIdx
      // alone doesn't retrigger this effect when the index doesn't actually
      // change (single-hit sessions: len-1 === 0 === current) and the very
      // first landing never scrolled at all
      jumpNewestRef.current = false;
      const last = matches.length - 1;
      setMatchIdx(last);
      jumpTo(matches[last]);
      return;
    }
    jumpTo(matches[safeIdx]);
  }, [matches, safeIdx]);

  const roomRef = useRef<Room | null>(null);
  const modeRef = useRef<Mode>('text');
  const unmountedRef = useRef(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const voicePromiseRef = useRef<Promise<Room> | null>(null);
  // self-heal reconnect: one attempt scheduled at a time, backing off while
  // it keeps failing — without this a stale room could tear down its own
  // replacement and storm LiveKit (seen 2026-09-25: ~5 reconnects/sec)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectFailsRef = useRef(0);
  // PTT intent survives an async room connect: if the finger lifted before
  // the room was ready, the mic must not be left hot by connectVoice
  const pttWantRef = useRef(false);
  const echoesRef = useRef<Msg[]>([]);
  const seenRef = useRef(0);
  const pollInFlightRef = useRef(false);
  // "working…" clears only when the run is really over: opencode emits one
  // assistant message per STEP, so the first reply chunk is not the end.
  // The proxy reports the last raw message + its completed timestamp; the
  // run counts as finished only when that state is unchanged across two
  // polls (~2.5s apart) AND the completed timestamp is set (ends "|0" means
  // in-progress: user msg last or step still streaming — thinking models
  // can hold that state for minutes) AND the transcript grew since the send
  // (a stable pre-send state from the previous run must not clear it).
  const runStateRef = useRef('');
  const runStreakRef = useRef(0);
  // epoch ms of the last poll that actually returned data. The wedge guard
  // acts on run-state + live flag — both of which FREEZE when polls fail
  // (flaky tailnet link: diag 2026-09-29 22:07-22:12 shows GET /messages
  // failing while the run was alive). Acting on frozen evidence auto-aborts
  // healthy runs — "working in the list but nothing in the session" — so a
  // wedge verdict now requires a successful poll within the last 15s.
  const lastGoodPollRef = useRef(0);
  const totalRef = useRef(0);
  const runBaseTotalRef = useRef(0);
  // definitive "run in flight" from the proxy (its async POST resolves only
  // when the run finishes) — immune to long between-steps thinking
  const liveRef = useRef(false);
  // epoch ms the proxy last saw a run finish for this session — authoritative
  // "your run is over" even when opencode leaves a message un-completed
  const runEndedRef = useRef(0);
  // synchronous mirror of busy: the poller arms hands-free runs without
  // re-arming on every tick while one is already being watched
  const busyRef = useRef(false);
  busyRef.current = busy;
  // arms ONE busy-restoration check on entering a session: navigating away
  // and back (or a reload) must re-show the working indicator
  const autoArmRef = useRef('');

  /** Reset run tracking at send time so the previous run's settled state
   *  can't instantly clear the new "working…" indicator. */
  function armRunWatch() {
    const queued = busyRef.current; // already working → this send queues up
    runStateRef.current = '';
    runStreakRef.current = 0;
    runBaseTotalRef.current = totalRef.current;
    // a queued message must NOT restart the elapsed counter — the working
    // period started with the first message and ends when the queue drains
    if (!queued) busyStartRef.current = Date.now();
    // mirror synchronously — setBusy(true) only lands on the next render,
    // and back-to-back sends would otherwise each see "not busy yet"
    busyRef.current = true;
    busyBeatRef.current = 0;
    diagEvent(
      'busy',
      queued
        ? `arm ${slug} (QUEUED — timer keeps running, ${Math.round((Date.now() - busyStartRef.current) / 1000)}s)`
        : `arm ${slug} (send)`
    );
  }
  const wedgeFiredRef = useRef(false);
  // 10s heartbeat cadence for the busy metrics (avoids a log line per second)
  const busyBeatRef = useRef(0);
  // epoch ms the current busy period started — the "working… Ns" counter is
  // derived from it so a page refresh keeps the TRUE elapsed time
  const busyStartRef = useRef(Date.now());

  /** Show the user's own message instantly; the poll reconciles later. */
  function addEcho(text: string, images: string[] = []) {
    const m: Msg = { role: 'user', text: text || '(📎 attachment)', images, time: Date.now() };
    echoesRef.current = [...echoesRef.current, m];
    setMsgs((prev) => [...prev, m]);
    stickRef.current = true;
  }

  /** Discord-style growth: 1 line up to ~4, then internal scroll. */
  function autogrow(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }

  // --- composer history recall (req: ArrowUp/Down on PC, slide on the
  // textarea on phone — right = past messages, left = back toward the
  // draft; past the newest = back to "no message" i.e. the live draft) ---
  // the history is the session's own user messages (typed + voice), so it
  // survives reloads; file fences are stripped via userProse
  const sentHistory = useMemo(
    () =>
      msgs
        .filter((m) => m.role === 'user')
        .map((m) => userProse(m.text))
        .filter((t) => t.trim() && t !== '(📎 attachment)'),
    [msgs]
  );
  // null = live draft; 0..n-1 = index into sentHistory (0 = oldest)
  const [histPos, setHistPos] = useState<number | null>(null);
  const histPosRef = useRef<number | null>(null);
  const draftRef = useRef('');

  /** Put the recalled text in the composer: state + caret at end + autogrow. */
  function setRecalled(text: string) {
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.setSelectionRange(el.value.length, el.value.length);
      autogrow(el);
    });
  }

  function recall(dir: 'older' | 'newer') {
    const hist = sentHistory;
    if (!hist.length) return;
    if (dir === 'older') {
      if (histPosRef.current === null) {
        draftRef.current = input; // park the live draft
        histPosRef.current = hist.length - 1; // newest sent message
      } else {
        histPosRef.current = Math.max(0, histPosRef.current - 1);
      }
      histPosRef.current = Math.max(0, histPosRef.current);
      setHistPos(histPosRef.current);
      setRecalled(hist[histPosRef.current]);
    } else {
      if (histPosRef.current === null) return; // already live — nothing newer
      if (histPosRef.current >= hist.length - 1) {
        // past the newest → back to the live draft ("no message")
        histPosRef.current = null;
        setHistPos(null);
        setRecalled(draftRef.current);
        draftRef.current = '';
        return;
      }
      histPosRef.current += 1;
      setHistPos(histPosRef.current);
      setRecalled(hist[histPosRef.current]);
    }
  }

  /** Manual edit while browsing history → that text is the live draft now. */
  function liveEdit(text: string) {
    if (histPosRef.current !== null) {
      histPosRef.current = null;
      setHistPos(null);
      draftRef.current = '';
    }
    setInput(text);
  }

  const histChip =
    histPos !== null && sentHistory.length > 0
      ? `history ${histPos + 1}/${sentHistory.length} · ↓ back to draft`
      : '';
  // phone: slide on the textarea itself (touch only — a mouse-drag there
  // must stay text selection; PC uses the arrow keys)
  const taSwipeRef = useSwipeX<HTMLTextAreaElement>({
    threshold: 56,
    touchOnly: true,
    onCommit: recall,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  // auto-scroll only while the user is parked at (or near) the bottom;
  // scrolling up to read history must not be fought by the poller
  const stickRef = useRef(true);

  useEffect(() => {
    params.then((p) => {
      setSlug(p.slug);
      echoesRef.current = [];
      seenRef.current = 0;
      setLimit(60);
      // composer recall resets with the session: no history position, no
      // parked draft leaking across sessions
      histPosRef.current = null;
      setHistPos(null);
      draftRef.current = '';
      // fresh view: the previous session's run tracking must not leak in —
      // the first poll below may restore busy if a run is live here
      setBusy(false);
      setError('');
      runStateRef.current = '';
      runStreakRef.current = 0;
      runBaseTotalRef.current = 0;
      totalRef.current = 0;
      liveRef.current = false;
      autoArmRef.current = p.slug;
      // per-session draft: typing here, leaving, coming back must restore it
      try {
        const draft = localStorage.getItem('oz-draft:' + p.slug) || '';
        setInput(draft);
        if (draft) {
          requestAnimationFrame(() => {
            if (inputRef.current) autogrow(inputRef.current);
          });
        }
      } catch {
        /* private mode */
      }
      // instant paint from the session cache while the fresh fetch runs
      try {
        const raw = sessionStorage.getItem('oz-cache:' + p.slug);
        if (raw) {
          const c = JSON.parse(raw);
          if (Array.isArray(c.msgs) && c.msgs.length) {
            setMsgs(c.msgs);
            setTotal(c.total || c.msgs.length);
            seenRef.current = c.msgs.length;
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            });
          }
        }
      } catch {
        /* no cache */
      }
    });
  }, [params]);

  // PC tab shows which session you're in: "Bifrost - <slug>"; leaving the
  // session view (unmount) restores the plain title
  useEffect(() => {
    document.title = slug ? `Bifrost - ${slug}` : 'Bifrost';
    return () => {
      document.title = 'Bifrost';
    };
  }, [slug]);

  // deep link from global search: /session/<slug>?q=… opens the search
  // overlay pre-filled; once transcripts load the jump effect lands on the
  // newest match (jumpNewestRef)
  useEffect(() => {
    searchParams.then((p) => {
      const q = (p.q || '').trim();
      if (!q) return;
      jumpNewestRef.current = true;
      setSearchOpen(true);
      setQuery(q);
    });
  }, [searchParams]);

  const loadMsgs = useCallback(
    async (lim?: number) => {
      // backgrounded mobile tabs freeze in-flight polls for minutes and then
      // fail in a burst on resume — never poll while hidden, never overlap
      if (!slug || pollInFlightRef.current || document.hidden) return;
      pollInFlightRef.current = true;
      try {
        const want = lim ?? limit;
        const r = await fetch(`/api/session/${slug}/messages?limit=${want}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) {
          lastGoodPollRef.current = Date.now();
          const fresh: Msg[] = await r.json();
          const totalCount = Number(r.headers.get('X-Total-Count') || fresh.length);
          setTotal(totalCount);
          totalRef.current = totalCount;
          const st = r.headers.get('X-Run-State') || '';
          liveRef.current = r.headers.get('X-Run-Live') === '1';
          const liveSinceMs = Number(r.headers.get('X-Run-Live-Since') || 0);
          runEndedRef.current = Number(r.headers.get('X-Run-Ended') || 0);
          // "id|completed|lastRole" — completed=0 while a step runs or the
          // last raw message is the user's own prompt
          const [, done] = st.split('|');
          if (st && st === runStateRef.current) {
            runStreakRef.current += 1;
          } else {
            // metric: every transcript/run-state transition, with what the
            // client saw — this is the primary "why is it still working" trail
            diagEvent(
              'run',
              `${slug} → ${st || '(none)'} live=${liveRef.current ? 1 : 0} total=${totalCount}`
            );
            runStateRef.current = st;
            // fresh state that already shows a completed run = seen once
            runStreakRef.current = done === '0' ? 0 : 1;
          }
          // entry arm: a prompt was sent before navigating away (or the run
          // is live from another client) → bring the working indicator back.
          // Stale unanswered prompts (aborted/failed, past the TTL) must NOT
          // re-arm — nothing is running there
          if (autoArmRef.current === slug) {
            autoArmRef.current = '';
            const lastMsg = fresh[fresh.length - 1];
            const lastT = lastMsg?.time || 0;
            const freshPrompt = st.endsWith('|0|user') && lastT > Date.now() - PENDING_TTL_MS;
            // a streaming step ("|0|assistant") is a live run too — voice
            // prompts bypass the proxy so their only trace is the transcript.
            // Freshness-gated: a hours-old un-completed step is opencode
            // bookkeeping debris, not a run
            const streamingStep =
              st.endsWith('|0|assistant') && lastT > Date.now() - PENDING_TTL_MS;
            if (liveSinceMs || liveRef.current || freshPrompt || streamingStep) {
              runBaseTotalRef.current = totalCount;
              // true elapsed: proxy-tracked start, else the last message's
              // time (best available estimate for voice-driven runs)
              const since = liveSinceMs || lastT || Date.now();
              busyStartRef.current = since;
              const elapsed = Math.max(0, Math.round((Date.now() - since) / 1000));
              setBusySecs(elapsed);
              setBusy(true);
              const via = liveSinceMs ? 'live' : streamingStep ? 'step' : 'prompt';
              diagEvent('busy', `arm ${slug} (entry ${via}) elapsed=${elapsed}s`);
            }
          }
          // backgrounded + the run's final answer landed = notify (a bare
          // assistant message is not enough — steps land mid-run)
          const lastFresh = fresh[fresh.length - 1];
          // hands-free has no local send: the agent commits turns itself, so
          // the poll must arm the working indicator when new user speech
          // lands — otherwise nothing on screen reacts until a page reload
          if (
            modeRef.current === 'free' &&
            !busyRef.current &&
            fresh.length > seenRef.current &&
            lastFresh?.role === 'user'
          ) {
            setBusy(true);
            armRunWatch();
          }
          if (
            document.hidden &&
            runStreakRef.current >= 1 &&
            lastFresh?.role === 'assistant' &&
            fresh.length > seenRef.current
          ) {
            void notifyReply(slug);
          }
          // keep optimistic echoes until the server transcript catches up
          const echoes = echoesRef.current.filter(
            (e) => !fresh.some((m) => m.role === 'user' && m.text === e.text)
          );
          setMsgs([...fresh, ...echoes]);
          try {
            if (JSON.stringify(fresh).length < 300_000) {
              sessionStorage.setItem(
                'oz-cache:' + slug,
                JSON.stringify({
                  msgs: fresh,
                  total: Number(r.headers.get('X-Total-Count') || fresh.length),
                })
              );
            }
          } catch {
            /* quota — skip cache */
          }
        }
      } catch {
        /* transient */
      } finally {
        pollInFlightRef.current = false;
      }
    },
    [slug, limit]
  );

  useEffect(() => {
    loadMsgs();
    const t = setInterval(loadMsgs, 2500);
    // visibility metric + catch-up: log hide/show with the busy state at the
    // moment of the transition (background freeze is the #1 suspect for
    // stale indicators), then two polls back-to-back — the busy-clear needs
    // two identical run states, and after a long background freeze the first
    // poll only SEEDS the streak — without the second, a finished run shows
    // a stale "working… 700s+" until the user interacts (re-arming wrongly)
    const onVisible = () => {
      diagEvent(
        'vis',
        `${slug} → ${document.hidden ? 'hidden' : 'visible'}` +
          (document.hidden || !busyRef.current
            ? ` busy=${busyRef.current ? 'yes' : 'no'}`
            : ` busy=${Math.round((Date.now() - busyStartRef.current) / 1000)}s`)
      );
      if (document.hidden) return;
      void loadMsgs().then(() => loadMsgs());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadMsgs]);

  useEffect(() => {
    seenRef.current = Math.max(seenRef.current, msgs.length);
    // everything on screen counts as read — the list drops its unread badge
    const lastT = msgs.length ? msgs[msgs.length - 1].time : 0;
    if (slug && lastT) markRead(slug, lastT);
    if (!stickRef.current) return;
    // hard snap (scrollIntoView races late layout from images/fonts)
    const snap = () => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    snap();
    requestAnimationFrame(snap);
    const t = setTimeout(snap, 300);
    return () => clearTimeout(t);
  }, [msgs]);

  useEffect(() => {
    if (!busy) return;
    wedgeFiredRef.current = false;
    // elapsed derives from busyStartRef (true run start — survives refresh)
    const t = setInterval(() => {
      const sec = Math.max(0, Math.round((Date.now() - busyStartRef.current) / 1000));
      setBusySecs(sec);
      // heartbeat metric: every 10s of busy, record exactly WHY it's still
      // busy — live flag, clear-condition streak, run state, transcript growth
      if (sec - busyBeatRef.current >= 10) {
        busyBeatRef.current = sec;
        diagEvent(
          'busy',
          `tick ${slug} ${sec}s live=${liveRef.current ? 1 : 0} ` +
            `streak=${runStreakRef.current}/2 ${runStateRef.current || '(none)'} ` +
            `total=${totalRef.current}/${runBaseTotalRef.current}`
        );
      }
      // done = the proxy no longer reports a live run, two consecutive polls
      // saw the same run state, that state is a COMPLETED assistant message
      // (mid part "0" = in-progress — thinking models can hold it for
      // minutes), and the transcript grew past what existed at send time
      // heuristic: stable completed state across two polls…
      const settled = runStreakRef.current >= 2 && runStateRef.current.split('|')[1] !== '0';
      // …or the proxy itself saw the run finish after this busy period began
      // (opencode sometimes ends a run leaving completed=0 on the last
      // message — without this the indicator would stick forever)
      const endedAfterStart = !liveRef.current && runEndedRef.current > busyStartRef.current;
      if (
        (settled || endedAfterStart) &&
        totalRef.current > runBaseTotalRef.current &&
        !liveRef.current
      ) {
        diagEvent('busy', `clear ${slug} after ${sec}s`);
        setBusy(false);
        busyBeatRef.current = 0;
        runStreakRef.current = 0;
        clearAsked(slug);
        // arrival wait with no SSE idle in hand (subscribed late, run ended
        // between polls): nudge the same speak path idle would have taken,
        // or the mic stays paused forever (req 09-30)
        if (
          modeRef.current === 'free' &&
          freeCycleRef.current === 'processing' &&
          arrivedBusyRef.current &&
          !freeSpokeMsgRef.current &&
          !runIdleRef.current
        ) {
          arrivedBusyRef.current = false;
          freeWaitSinceRef.current = 0;
          runIdleRef.current = true;
          setIdleTick((t) => t + 1);
          armFreeEscape(15_000, 'arrival busy-clear: no speech started in 15s');
        }
        if (document.hidden) void notifyReply(slug);
        return;
      }
      // wedge guard: 30s busy, NO live run, the LAST raw message is still
      // the user's own prompt → the runner never picked the message up
      // (hung earlier run, dead queue). Abort so the session un-wedges;
      // the prompt stays in the transcript, user can resend.
      // Poll-freshness gate: a frozen |0|user from FAILED polls is not
      // evidence (2026-09-29: flaky link froze the state, the guard
      // aborted a healthy 5-minute run) — only abort on fresh proof.
      if (
        !wedgeFiredRef.current &&
        sec >= 30 &&
        Date.now() - lastGoodPollRef.current < 15_000 &&
        !liveRef.current &&
        runStateRef.current.endsWith('|0|user')
      ) {
        wedgeFiredRef.current = true;
        diagEvent('busy', `wedge ${slug} after ${sec}s (auto-abort)`);
        setError('no reply — the run seemed stuck, auto-stopped. Send again.');
        setBusy(false); // the aborted prompt never completes on its own
        void fetch(`/api/session/${slug}/abort`, { method: 'POST' }).catch(() => {});
      }
    }, 1000);
    return () => clearInterval(t);
  }, [busy, slug]);

  // disconnect voice when leaving the page
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      clearHoldArm();
      roomRef.current?.disconnect();
      roomRef.current = null;
      stopSpeech(); // leaving the page kills the tts deck
    };
  }, []);

  // preconnect voice on page load: a PTT press must turn the mic on in
  // ~200ms, but a fresh token+signal+agent join takes seconds on a laggy
  // link — a hold shorter than the connect dropped the whole turn (live
  // 20:44:39: ready and released in the same second, mic never enabled).
  // The room connects with the mic off: no capture device is opened until
  // a hold enables it, so the phone shows no mic-in-use while idle.
  useEffect(() => {
    // runs when the slug lands (and on a slug change): preconnecting with an
    // empty slug minted a random fallback room — see ensureVoice's guard
    if (!slug) return;
    void (async () => {
      try {
        await ensureVoice();
        // restore hands-free across refresh (oz-mode written by switchMode/
        // exitFree): voice ready → arm the mic. If the browser refuses a
        // gesture-less mic (autoplay policy), fall back to keyboard loudly.
        let wantFree = false;
        try {
          wantFree = localStorage.getItem('oz-mode') === 'free';
        } catch {
          /* private mode */
        }
        if (wantFree && modeRef.current === 'text' && !unmountedRef.current) {
          try {
            modeRef.current = 'free';
            setMode('free');
            setFreeCycle('listening');
            await mic(true);
            diagEvent('voice', 'hands-free restored after refresh');
          } catch (e) {
            modeRef.current = 'text';
            setMode('text');
            // a PERMISSION refusal is sticky — storing 'text' keeps every
            // future navigation from fighting the browser. Anything else
            // (transient voice failure, flaky link) keeps 'free' stored so
            // the next session/refresh retries hands-free on its own
            // (req 09-30: the mode must survive moving between sessions)
            const denied =
              e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
            if (denied) {
              try {
                localStorage.setItem('oz-mode', 'text');
              } catch {
                /* private mode */
              }
            }
            setError('hands-free needs one tap after a refresh — tap the mic button');
          }
        }
      } catch {
        /* preconnect failure — the first press surfaces it */
      }
    })();
  }, [slug]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // --- tts deck handlers ---
  const lastAssistant = useMemo(
    () => [...msgs].reverse().find((m) => m.role === 'assistant' && m.text.trim()),
    [msgs]
  );

  function seekFracFromEvent(e: React.PointerEvent): number {
    const el = seekRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  async function ensureVoice(): Promise<Room> {
    if (roomRef.current && voiceState === 'ready') return roomRef.current;
    if (voicePromiseRef.current) return voicePromiseRef.current;
    // params unwrap is async: on first mount slug is still '' — minting
    // then would create a random fallback room in the token route (and the
    // agent would spawn a phantom opencode session titled after it, live
    // 2026-09-29: room "" → session_6898). No token until the slug lands;
    // the preconnect effect re-runs on [slug].
    if (!slug) throw new Error('voice: session slug not ready yet');
    setVoiceState('connecting');
    voicePromiseRef.current = connectVoice();
    return voicePromiseRef.current;
  }

  /** Single self-heal path for a dropped/stale room: deduped by timer,
   *  exponential backoff while connects keep failing. */
  function reconnectVoice() {
    if (unmountedRef.current || reconnectTimerRef.current) return;
    reconnectTimerRef.current = setTimeout(
      () => {
        reconnectTimerRef.current = null;
        if (unmountedRef.current) return;
        ensureVoice()
          .then((r) => {
            reconnectFailsRef.current = 0;
            if (modeRef.current === 'free') return r.localParticipant.setMicrophoneEnabled(true);
            return undefined;
          })
          .catch(() => {
            reconnectFailsRef.current += 1; // next attempt waits longer
            reconnectVoice();
          });
      },
      Math.min(4_000, 250 * 2 ** reconnectFailsRef.current)
    );
  }

  async function connectVoice(): Promise<Room> {
    try {
      try {
        const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        diagEvent('voice', `mic permission: ${p.state}`);
        if (p.state === 'denied') {
          throw new Error('microphone blocked — allow it in browser site settings (lock icon)');
        }
      } catch (e) {
        if (String(e).includes('blocked')) throw e;
        diagEvent('voice', 'permissions API unavailable');
      }
      const r = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: slug }),
      });
      const d = await r.json();
      const room = new Room({ adaptiveStream: false });
      room.on(RoomEvent.SignalConnected, () => diagEvent('voice', 'signal connected'));
      room.on(RoomEvent.Connected, () => diagEvent('voice', 'room connected'));
      room.on(RoomEvent.Disconnected, () => {
        diagEvent('voice', 'room disconnected');
        // the room's join token is stale now — reconnecting with it just 401s
        // ("token is expired"). Drop it so the next connect mints a fresh one.
        roomRef.current = null;
        voicePromiseRef.current = null;
        setVoiceState('off');
        // self-heal ONLY while voice is actually wanted (e.g. the phone slept
        // past the token TTL and the server dropped the room). A deliberate
        // keyboard-mode release fires this event too: reconnecting there
        // spawned a muted zombie room with no voice agent in it — the
        // "listening" animation kept running but nothing transcribed or sent
        // (2026-09-25 veraldar-org---home). Explicit reconnectVoice() callers
        // (stale-turn recovery in pttUp) bypass this gate on purpose.
        const wantsVoice = modeRef.current !== 'text' || pttWantRef.current;
        if (!unmountedRef.current && wantsVoice) reconnectVoice();
      });
      room.on(RoomEvent.MediaDevicesError, (e: Error) => diagEvent('voice-fail', String(e)));
      diagEvent('voice', 'connecting signal…');
      await withTimeout(room.connect(d.serverUrl, d.participantToken), 12_000, 'signal');
      diagEvent('voice', 'connected, mic stays muted until a mode/handler turns it on');
      // the agent calls this on "over and out": leave hands-free, teardown
      // to keyboard (the final reply lands as text in the session instead
      // of being spoken — radio "out" expects no answer)
      room.localParticipant.registerRpcMethod('end_free', async () => {
        diagEvent('voice', 'end_free rpc — exiting hands-free');
        void exitFree();
        return 'ok';
      });
      // keyword turn cycle: processing = mute mic + working animation while
      // opencode runs; the phone itself speaks the reply (auto-listen below)
      // and returns the mic when playback ends
      room.localParticipant.registerRpcMethod('free_state', async (data) => {
        let state = '';
        try {
          state = JSON.parse(data.payload).state;
        } catch {
          return 'bad-payload';
        }
        if (state === 'processing') {
          setFreeCycle('processing');
          await mic(false);
        }
        return 'ok';
      });
      roomRef.current = room;
      setVoiceState('ready');
      diagEvent('voice', 'ready');
      return room;
    } catch (e) {
      setError(`voice connect failed: ${e instanceof Error ? e.message : e}`);
      setVoiceState('off');
      voicePromiseRef.current = null;
      throw e;
    }
  }

  async function mic(on: boolean) {
    await roomRef.current?.localParticipant.setMicrophoneEnabled(on);
  }

  /** Text-mode PTT: release the CAPTURE DEVICE between holds. A muted track
   *  still holds the mic hardware (phone shows 'mic in use' — req 09-29
   *  'mic on only on push to talk'), and a full room teardown forces a
   *  reconnect on the next press — slower than the hold on a laggy link.
   *  So the room + agent stay warm; unpublishing stops the device, and the
   *  next hold's setMicrophoneEnabled(true) re-acquires it (~200ms). */
  function releaseMicDevice(room: Room) {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (pub?.track) {
      try {
        room.localParticipant.unpublishTrack(pub.track, true);
      } catch {
        /* track already gone */
      }
    }
  }

  // radio "out": the agent committed the final turn — release the capture
  // device exactly like switchMode('text'), but without its same-mode guard
  // (the RPC handler must work no matter what the closure saw). The room and
  // the agent in it stay warm: a PTT hold right after "over and out" must
  // find the agent present, not race its re-dispatch (see switchMode).
  async function exitFree() {
    modeRef.current = 'text';
    setMode('text');
    setFreeCycle('listening');
    try {
      localStorage.setItem('oz-mode', 'text');
    } catch {
      /* private mode */
    }
    const room = roomRef.current;
    if (room) releaseMicDevice(room);
    diagEvent('voice', 'released (over and out) — mic device released, room stays warm');
  }

  async function switchMode(next: Mode) {
    if (next === mode) return;
    setError('');
    setMode(next); // optimistic — bottom UX must react immediately
    // sync the ref NOW: the disconnect below fires RoomEvent.Disconnected
    // asynchronously and the self-heal must already see the new mode, or it
    // reconnects a room the user just left (socket that never closes)
    modeRef.current = next;
    // survive refresh: mode is component state, a reload silently dropped
    // hands-free to keyboard (req 09-29 'it switching from hf to keyboard')
    try {
      localStorage.setItem('oz-mode', next);
    } catch {
      /* private mode — restore just won't happen */
    }
    try {
      if (next === 'text') {
        // Keyboard mode releases the CAPTURE DEVICE, not the room: tearing
        // the room down here forced the next PTT press to re-dispatch the
        // voice agent (~1-2s) — a hold shorter than that join delivered
        // neither ptt_begin nor commit_turn (both are guarded on the agent
        // being present) and the whole turn was dropped (req 09-29
        // 'switching from hand free to keyboard and then using the push to
        // talk is not working'). The unpublish closes the device (the phone
        // mic-in-use indicator clears); room + agent stay warm so the next
        // hold re-acquires the mic in ~200ms.
        const room = roomRef.current;
        if (room) releaseMicDevice(room);
        diagEvent('voice', 'keyboard mode — mic device released, room stays warm');
      } else {
        // hands-free: mic stays on, turns are keyword-driven — the agent
        // buffers everything until "over" / "over and out" (agent.py).
        // PTT from the composer works in both modes (mic mutes on release).
        setFreeCycle('listening');
        // fresh entry: the arrival cycle (req 09-30) must re-evaluate — a
        // stale flag from an exited session would block the next arm
        arrivedBusyRef.current = false;
        const room = await ensureVoice();
        await mic(true);
        // honesty check: hands-free renders "listening" from local mic levels
        // alone — if the voice agent never joined (lk-agent down, dispatch
        // lost), surface it instead of faking it (2026-09-25: the animation
        // ran for minutes with nobody transcribing)
        window.setTimeout(() => {
          if (unmountedRef.current || modeRef.current !== 'free') return;
          if (roomRef.current === room && room.remoteParticipants.size === 0) {
            diagEvent('voice-fail', 'hands-free: no voice agent in the room after 10s');
            setError('voice agent missing from the room — is lk-agent running? tap the mic button to retry');
          }
        }, 10_000);
      }
    } catch {
      setMode('text'); // connect/mic failed (error surfaced by ensureVoice)
    }
  }

  async function pttDown(e?: React.PointerEvent<HTMLButtonElement>) {
    // deliberately NOT gated on busy: talking while the agent works queues
    // the turn (opencode serializes per session); stop is the only cancel
    pttWantRef.current = true;
    pttCancelArmRef.current = false;
    setPttCancelArm(false);
    // instant feedback: hold UI (equalizer slot) appears on press — the bars
    // stay flat until the room + mic track are actually live
    setHolding(true);
    if (e) pttStartRef.current = { x: e.clientX, y: e.clientY };
    try {
      // lazily connect from any mode (first press pays the connect cost)
      const room = await ensureVoice();
      if (!pttWantRef.current) {
        // finger lifted before the room was ready — mic was never enabled,
        // so nothing was captured: the spoken words are gone. Never silent
        // again (req 09-29 'after refresh push to talk doesn't go through'):
        // the user must know the press was pre-connect, not swallowed.
        setHolding(false);
        diagEvent('ptt', 'lifted before the voice room was ready — turn not captured');
        setError('was still connecting — hold the mic again');
        return;
      }
      // agent holds turns manual until release — a mid-sentence pause while
      // the button is down must not flush a partial message (fire & forget)
      const agent = Array.from(room.remoteParticipants.values())[0];
      if (agent) {
        void room.localParticipant
          .performRpc({
            destinationIdentity: agent.identity,
            method: 'ptt_begin',
            payload: '{}',
            responseTimeout: 4_000,
          })
          .catch(() => {});
      }
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch {
      setHolding(false); // connect/mic failed — error already surfaced by ensureVoice
    }
  }

  // Discord-style slide-to-cancel: sliding left past the threshold enters a
  // "deleting" zone — mic stays hot, nothing is lost; slide back right and
  // the talk continues; releasing inside the zone discards the turn
  const [pttCancelArm, setPttCancelArm] = useState(false);
  // synchronous mirror of pttCancelArm: pointer events fire faster than
  // React state settles, the release must see the same truth the move saw
  const pttCancelArmRef = useRef(false);
  const pttStartRef = useRef({ x: 0, y: 0 });
  // tap-vs-hold (req 09-30): a quick press is the hands-free TOGGLE, a hold
  // is push-to-talk. The PTT path (hold UI + mic enable) arms only after the
  // press survives 250ms — a tap NEVER touches the capture device, so
  // toggling can't churn the publisher transport (rapid enable/disable
  // killed ICE in the live room 2026-09-30) and a tap can't buffer audio.
  const holdArmRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function clearHoldArm() {
    if (holdArmRef.current) {
      clearTimeout(holdArmRef.current);
      holdArmRef.current = null;
    }
  }

  function pttDiscardRpc() {
    const room = roomRef.current;
    const agent = room && Array.from(room.remoteParticipants.values())[0];
    if (room && agent) {
      void room.localParticipant
        .performRpc({
          destinationIdentity: agent.identity,
          method: 'ptt_abort',
          payload: '{}',
          responseTimeout: 4_000,
        })
        .catch(() => {});
    }
  }

  function pttCancel() {
    // finger left the button (back-gesture / pointercancel) — release = discard
    void pttUp(true);
  }

  async function pttUp(forceDiscard?: boolean) {
    // browsers double-fire releases on touch (pointerup then pointerleave);
    // without this guard a second pttUp would tear down the room its first
    // invocation just reconnected — the reconnect storm of 2026-09-25
    if (!pttWantRef.current) return;
    const discard = forceDiscard ?? pttCancelArmRef.current;
    pttWantRef.current = false;
    pttCancelArmRef.current = false;
    setPttCancelArm(false);
    setHolding(false);
    const room = roomRef.current;
    if (!room) {
      // released while the room was still connecting (refresh + immediate
      // press on a laggy link): nothing was captured — say so, don't swallow
      diagEvent('ptt', 'released before the voice room existed — turn not captured');
      setError('was still connecting — hold the mic again');
      return;
    }
    if (discard) {
      // released inside the delete zone — drop the buffered turn
      if (modeRef.current !== 'free') await mic(false);
      pttDiscardRpc();
      // text mode: release the capture device (room stays warm for the
      // next press; the abort RPC already went out over the live room)
      if (modeRef.current !== 'free') releaseMicDevice(room);
      return;
    }
    if (modeRef.current !== 'free') await mic(false); // hands-free keeps listening
    stickRef.current = true;
    setBusy(true); // cleared when the run state settles (see poller)
    armRunWatch();
    try {
      // the agent may still be joining (press right after a page reload) —
      // wait it out instead of dropping the commit into an empty room
      const agent = await agentInRoom(room, 4_000);
      if (pttWantRef.current) {
        // a newer hold began while we waited — ITS release owns the commit
        // now; flushing here would cut the new hold's audio mid-sentence
        return;
      }
      if (!agent) {
        diagEvent('voice-fail', 'commit: no voice agent in the room after 4s');
        setError('voice agent missing from the room — is lk-agent running? try again in a moment');
        setBusy(false);
        return;
      }
      const res = await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: 'commit_turn',
        payload: '{}',
        // agent worst case: 1.5s flush + 8s transcript wait — an RPC
        // timeout here reads as "stale room" and drops a commit that
        // would still have landed
        responseTimeout: 14_000,
      });
      // agent answered but its session is dead (stale room) → reconnect
      if (res && res !== 'ok') throw new Error(res);
    } catch {
      // stale voice session (e.g. the agent's session closed earlier) — a
      // retry against the same room keeps failing, so drop it and reconnect
      // with a fresh token; the agent side ends the job with its session,
      // so the fresh room gets a fresh agent (no zombie to fail again)
      setError('voice session stale — reconnecting…');
      setBusy(false);
      if (roomRef.current === room) {
        // only drop OUR room — a newer reconnect must not be torn down
        roomRef.current = null;
        voicePromiseRef.current = null;
        setVoiceState('off');
        void room.disconnect();
      }
      // the fresh-room self-heal only matters while voice is still wanted;
      // in text mode the next hold reconnects anyway — a reconnect here
      // would re-open the mic device the release contract just closed
      if (modeRef.current === 'free') reconnectVoice();
      return;
    }
    // text mode: the turn is committed and the reply arrives over the
    // session poller — release the capture device for real (muting alone
    // keeps it open; the phone kept showing mic-in-use). The room stays
    // warm: the next press re-acquires the mic without a reconnect.
    if (modeRef.current !== 'free') releaseMicDevice(room);
  }

  // live mic equalizer (PTT pill + hands-free strip) — see useMicLevels
  const pttLevels = useMicLevels(holding, roomRef);
  // hands-free turn cycle, driven by the agent's free_state RPCs: "over"
  // mutes the mic while the reply is generated + spoken ("processing"),
  // then the mic comes back ("listening") for the next turn
  const [freeCycle, setFreeCycle] = useState<'listening' | 'processing'>('listening');
  // synchronous mirror: the escape timer's callback must see the CURRENT
  // cycle, not the one the timeout was armed from (busyRef pattern)
  const freeCycleRef = useRef(freeCycle);
  freeCycleRef.current = freeCycle;
  const freeLevels = useMicLevels(mode === 'free' && voiceState === 'ready', roomRef);

  // auto-listen cycle: while waiting for the reply (free_state "processing"),
  // the first assistant message that lands is spoken via the same TTS as the
  // listen chip. The mic stays muted from "over" until the playback is
  // finished or stopped — synthesis alone is not enough (it can start and
  // still fail), only real audio playback counts. The agent never speaks
  // over the room.
  const freeWaitSinceRef = useRef(0); // Date.now() when "over" committed
  const freeSpokeMsgRef = useRef(0); // time of the message we auto-started
  const freeSpokeRef = useRef(false); // real playback happened (phase=playing)
  const runIdleRef = useRef(false); // session.idle nudge seen — run fully over
  const escapedRef = useRef(false); // dead-stream escape fired this cycle
  const resumeRef = useRef(false); // re-entering processing to speak a late reply
  // arrival cycle (req 09-30): entered hands-free while the session was
  // already working — mic stays paused until the run settles, then the reply
  // auto-speaks via the normal idle path
  const arrivedBusyRef = useRef(false);
  // on-open autoplay bookkeeping: the last reply we already ATTEMPTED to
  // auto-play on arrival (a TTS failure must not loop on every poll)
  const openPlayedRef = useRef(0);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [idleTick, setIdleTick] = useState(0); // re-runs the speak effect on idle
  function freeMicGiveBack() {
    freeSpokeRef.current = false;
    freeSpokeMsgRef.current = 0;
    setFreeCycle('listening');
    if (modeRef.current === 'free') void mic(true);
  }
  // The mic is only given back unspeaked when the run-end channel is DEAD:
  // any SSE traffic (heartbeat, step, idle) proves it alive and re-arms this
  // timer. Real agent runs work 1-3 minutes (req 09-29: a flat 20s cap opened
  // the mic mid-work on every multi-step run and the reply then never spoke
  // itself), so silence alone is never evidence of a stuck run. A genuinely
  // hung run is the stall watchdog's job (abort at 10min → session.idle).
  function armFreeEscape(ms: number, why: string) {
    if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
    escapeTimerRef.current = setTimeout(() => {
      escapeTimerRef.current = null;
      if (freeCycleRef.current !== 'processing' || freeSpokeMsgRef.current) return;
      diagEvent('voice', `hands-free: ${why} — mic back unspeaked`);
      escapedRef.current = true;
      freeMicGiveBack();
    }, ms);
  }
  useEffect(() => {
    if (freeCycle === 'processing') {
      if (resumeRef.current) {
        // late-idle resume: the "over" timestamp and the idle flag must
        // survive, or the already-landed reply fails the speak gates below
        resumeRef.current = false;
      } else {
        freeWaitSinceRef.current = Date.now();
        freeSpokeMsgRef.current = 0;
        freeSpokeRef.current = false;
        runIdleRef.current = false;
        escapedRef.current = false;
      }
      // heartbeat every 25s — 35s of nothing means the stream is truly gone
      armFreeEscape(35_000, 'run-events stream dead 35s');
    }
    return () => {
      if (escapeTimerRef.current) {
        clearTimeout(escapeTimerRef.current);
        escapeTimerRef.current = null;
      }
    };
  }, [freeCycle]);
  useEffect(() => {
    if (freeCycle !== 'processing') return;
    // opencode completes one assistant message PER STEP: a mid-run step is a
    // "completed" message, and speaking it restarts the deck when the next
    // step lands 10-20s later (req 09-28: audio restarted from the start).
    // Speak only once the run is fully over (session.idle nudge).
    if (!runIdleRef.current) return;
    const a = lastAssistant;
    if (!a || a.time <= freeWaitSinceRef.current) return;
    // the reply streams: opencode creates the assistant message the moment
    // the run starts — speaking it then would read out a growing fragment.
    // Only a completed reply (time.completed) may be spoken.
    if (a.done === false) return;
    // message polls recreate objects — the SAME message must not restart
    // (a second startSpeech stops the first one mid-playback)
    if (freeSpokeMsgRef.current === a.time) return;
    freeSpokeMsgRef.current = a.time;
    try {
      startSpeech(a.text, slug);
    } catch {
      freeMicGiveBack(); // TTS failed to start — don't leave the mic hostage
    }
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeCycle, lastAssistant, slug, idleTick]);
  useEffect(() => {
    if (freeCycle !== 'processing') return;
    // LIVE store read, not the render snapshot: startSpeech() sets phase to
    // 'loading' during the previous effect — this effect's `speech` closure
    // still says 'idle', and trusting it handed the mic back immediately
    const live = getSpeech();
    if (live.phase === 'playing') {
      freeSpokeRef.current = true;
      // real audio went out — this reply counts as heard (req 09-30): a
      // later arrival in this session must not auto-play it again
      if (freeSpokeMsgRef.current) markHeard(slug, freeSpokeMsgRef.current);
      return;
    }
    // loading/paused keep the mic muted — nothing to hand back yet
    if (live.phase !== 'idle' || !freeSpokeMsgRef.current) return;
    // idle after a start attempt: natural end or user stop (freeSpokeRef
    // true), or playback never got going (TTS failure) — either way the
    // cycle is over, the mic goes back
    freeMicGiveBack();
  }, [freeCycle, speech.phase]);

  // run-completion channel, subscribed for the WHOLE hands-free session (not
  // just while processing): 'idle' late — after the dead-stream escape already
  // gave the mic back — must still arrive somewhere to trigger the recovery
  // below. Heartbeats are liveness only; 'step' refreshes the transcript.
  const loadMsgsRef = useRef(loadMsgs);
  loadMsgsRef.current = loadMsgs;
  useEffect(() => {
    if (mode !== 'free' || voiceState !== 'ready' || !slug) return;
    const es = new EventSource(`/api/run-events?slug=${encodeURIComponent(slug)}`);
    es.onmessage = (ev) => {
      // any traffic proves the stream alive — re-arm the dead-stream escape
      // (no-op while listening: the callback checks the cycle)
      armFreeEscape(35_000, 'run-events stream dead 35s');
      // 'idle' = session.idle = the whole run (every step) is over — the only
      // signal that may trigger the auto-listen; 'step' = one step message
      // completed mid-run, refresh-only
      if (ev.data === 'idle') {
        // arrived mid-run (req 09-30): the reply may have completed before
        // this cycle armed — the "not older than this cycle" gate would skip
        // it forever, so an arrival wait speaks any completed reply
        if (arrivedBusyRef.current) {
          arrivedBusyRef.current = false;
          freeWaitSinceRef.current = 0;
        }
        void loadMsgsRef.current(); // pull the completed reply instantly
        runIdleRef.current = true;
        setIdleTick((t) => t + 1);
        // stuck-cycle escape: idle arrived but nothing may speak (reply never
        // completes, or is older than this cycle) — 15s to start or mic goes
        // back; a real speech start flips freeSpokeMsgRef and cancels it
        armFreeEscape(15_000, 'idle seen but no speech started in 15s');
        // the escape already fired (mic back unspeaked) and the reply
        // finished anyway — re-enter the cycle to speak it. Mutes the mic
        // for the playback (one voice path); the user's speech keeps
        // buffering agent-side meanwhile (manual keyword turns), nothing lost
        if (escapedRef.current && freeCycleRef.current === 'listening') {
          escapedRef.current = false;
          resumeRef.current = true;
          setFreeCycle('processing');
        }
      } else if (ev.data === 'step') {
        void loadMsgsRef.current();
      }
    };
    return () => es.close();
  }, [mode, voiceState, slug]);

  // on-arrival voice cycle (req 09-30): entering a session hands-free must
  // match the room's reality BEFORE the mic goes hot —
  //  · session working → 'processing' (mic paused) until the run settles,
  //    then the reply auto-speaks (SSE idle above, or the busy-clear nudge)
  //  · idle + unheard completed reply → auto-play it once, mic muted for the
  //    playback like every other cycle
  //  · idle + everything heard → listening immediately, mic hot, talk away
  useEffect(() => {
    if (mode !== 'free' || voiceState !== 'ready' || freeCycle !== 'listening' || !slug) return;
    if (busy) {
      // arrivals only: the user's own commits (over / tap / text send) run
      // their own cycle — and arrivedBusyRef keeps the busy ticks that
      // follow from re-arming anything
      if (!arrivedBusyRef.current && freeCycleRef.current === 'listening') {
        arrivedBusyRef.current = true;
        void mic(false); // working — no talking into a run you didn't start
        setFreeCycle('processing');
        diagEvent('voice', 'arrived mid-run — mic paused until it settles');
      }
      return;
    }
    // stale sessionStorage paint must never speak: wait for the first real
    // poll (a mid-run step message can sit completed in the cache)
    if (!lastGoodPollRef.current) return;
    const a = lastAssistant;
    if (!a || a.done === false) return;
    if (a.time <= openPlayedRef.current || a.time <= lastHeard(slug)) return;
    openPlayedRef.current = a.time;
    freeWaitSinceRef.current = 0; // the heard-watermark gates, not "over"
    runIdleRef.current = true; // pretend the idle nudge arrived
    resumeRef.current = true; // entering processing must not wipe the flags
    void mic(false); // the playback holds the mic, same as every other cycle
    setFreeCycle('processing');
    setIdleTick((t) => t + 1);
    armFreeEscape(15_000, 'on-open unheard reply: no speech started in 15s');
    diagEvent('voice', 'on-open unheard reply — auto-play');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, voiceState, busy, freeCycle, lastAssistant, slug]);

  useEffect(() => {
    if (!holding) return;
    setPttSecs(0);
    const secs = setInterval(() => setPttSecs((s) => s + 1), 1_000);
    return () => clearInterval(secs);
  }, [holding]);

  // hands-free live timer: how long the always-on mic has been armed
  const [freeSecs, setFreeSecs] = useState(0);
  useEffect(() => {
    if (mode !== 'free') return;
    setFreeSecs(0);
    const secs = setInterval(() => setFreeSecs((s) => s + 1), 1_000);
    return () => clearInterval(secs);
  }, [mode]);

  async function loadOlder() {
    if (loadingOlder || !slug || total <= msgs.length) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight || 0;
    const next = limit + 120;
    setLimit(next);
    await loadMsgs(next);
    // keep the viewport anchored to the same content after prepending
    requestAnimationFrame(() => {
      const s = scrollRef.current;
      if (s) s.scrollTop = s.scrollHeight - prevHeight;
    });
    setLoadingOlder(false);
  }

  async function abortGeneration() {
    diagEvent(
      'busy',
      `abort ${slug} after ${Math.max(0, Math.round((Date.now() - busyStartRef.current) / 1000))}s (stop btn)`
    );
    try {
      await fetch(`/api/session/${slug}/abort`, { method: 'POST' });
    } catch {
      /* best effort */
    } finally {
      setBusy(false);
      runStreakRef.current = 0;
      await loadMsgs();
    }
  }

  async function addAttachments(files: FileList | null) {
    if (!files?.length) return;
    const picked = Array.from(files).slice(0, 4);
    const next: Attach[] = [];
    for (const f of picked) {
      try {
        if (f.type.startsWith('image/')) {
          next.push({ kind: 'image', name: f.name, dataUrl: await downscaleImage(f) });
        } else {
          next.push({ kind: 'file', name: f.name, content: (await f.text()).slice(0, 200_000) });
        }
      } catch (e) {
        setError(`could not read ${f.name}: ${e}`);
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next].slice(0, 8));
  }

  function sendText() {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    setInput('');
    // sent → composer history position back to live, parked draft dropped
    histPosRef.current = null;
    setHistPos(null);
    draftRef.current = '';
    try {
      localStorage.removeItem('oz-draft:' + slug);
    } catch {
      /* private mode */
    }
    if (inputRef.current) inputRef.current.style.height = 'auto';
    const images = attachments
      .filter((a): a is Extract<Attach, { kind: 'image' }> => a.kind === 'image')
      .map((a) => a.dataUrl);
    const files = attachments
      .filter((a): a is Extract<Attach, { kind: 'file' }> => a.kind === 'file')
      .map((a) => ({ name: a.name, content: a.content }));
    setAttachments([]);
    stickRef.current = true;
    void sendTextAsync(text, images, files);
  }

  async function sendTextAsync(
    text: string,
    images: string[],
    files: { name: string; content: string }[]
  ) {
    markAsked(slug);
    void ensureNotifyPermission();
    // sending while busy = queue behind the current run (opencode serializes
    // per session) — stopping is a separate, explicit action.
    // ALWAYS through the REST proxy — never via the room: the room carries
    // the text only to a voice agent, and when the agent job has ended
    // (human-left grace after any navigation, session close) sendText()
    // publishes into an empty room — no error, no transcript entry, nothing:
    // the message is gone while "working…" runs forever (live 09-30
    // hf-improve: two sends, total=56 frozen, list never showed working).
    // The agent's audio output is off anyway — the REST path lands the same
    // reply in the transcript AND arms the proxy run tracker (list dot,
    // live flag, wedge guard, busy clear).
    const willQueue = busyRef.current; // server will hold it in the proxy queue
    setBusy(true);
    armRunWatch();
    try {
      const r = await fetch(`/api/session/${slug}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, images, files, async: true }),
        // a hung radio/socket must surface as an error, not a silent stuck send
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error || `send failed (${r.status})`);
        setInput((prev) => (prev.trim() ? prev : text)); // draft back, no clobber
        setBusy(false);
      } else if (!willQueue) {
        addEcho(text, images); // queued sends come back via the poll instead
      }
      await loadMsgs();
    } catch {
      setError('send failed');
      setInput((prev) => (prev.trim() ? prev : text)); // draft back, no clobber
      setBusy(false);
    }
  }

  /** The voice toggle (req 09-30): a TAP on the composer mic. Enters
   *  hands-free; tapping again leaves it — and anything buffered mid-speech
   *  is discarded FIRST, so an exit never sends a half-said message. */
  function toggleHandsFree() {
    if (modeRef.current === 'free') {
      pttDiscardRpc(); // clear_user_turn agent-side: the buffer dies here
      void switchMode('text');
    } else {
      void switchMode('free');
    }
  }

  /** pointerup with the PTT path never armed (press released inside 250ms):
   *  pure tap — toggle hands-free. No mic was touched, nothing to discard. */
  function micTap() {
    clearHoldArm();
    toggleHandsFree();
  }

  /** Tap the live equalizer to commit the turn — the tap equivalent of
   *  saying "over" (both stay: keyword OR tap, req 09-30). Reuses pttUp's
   *  free-mode commit path minus the hold-specific state. */
  async function commitFreeTurn() {
    const room = roomRef.current;
    if (!room || modeRef.current !== 'free') return;
    if (freeCycleRef.current !== 'listening') return; // mid-cycle: agent owns the turn
    stickRef.current = true;
    setBusy(true); // cleared when the run state settles (see poller)
    armRunWatch();
    try {
      const agent = await agentInRoom(room, 4_000);
      if (!agent) {
        diagEvent('voice-fail', 'tap-to-send: no voice agent in the room after 4s');
        setError('voice agent missing from the room — is lk-agent running? try again in a moment');
        setBusy(false);
        return;
      }
      const res = await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: 'commit_turn',
        payload: '{}',
        responseTimeout: 14_000,
      });
      if (res && res !== 'ok') throw new Error(res);
      // tap = "over" (req 09-30: 'should be the same behavior as if I say
      // over'): the strip leaves listening — mic paused now, auto-speak on
      // idle, mic back when the spoken reply ends or is stopped. The agent
      // only sends free_state processing on the KEYWORD path; a tapped
      // commit would otherwise leave the equalizer bouncing and the mic hot
      // straight through the whole run, with the reply never spoken.
      setFreeCycle('processing');
      await mic(false);
    } catch {
      // same stale-room recovery as pttUp: drop OUR room, reconnect fresh
      setError('voice session stale — reconnecting…');
      setBusy(false);
      if (roomRef.current === room) {
        roomRef.current = null;
        voicePromiseRef.current = null;
        setVoiceState('off');
        void room.disconnect();
      }
      // the fresh-room self-heal only matters while voice is still wanted —
      // an exit-to-keyboard during the wait must not re-open the mic device
      if (modeRef.current === 'free') reconnectVoice();
    }
  }

  // Shared pointer handlers for the mic button — ONE button, both modes
  // (req 09-30): tap toggles hands-free, hold (+slide) is push-to-talk.
  // It never moves: text mode renders it right of the input, free mode
  // right of the strip — the exit is always where the entry was.
  const micHoldHandlers = {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      clearHoldArm();
      pttStartRef.current = { x: e.clientX, y: e.clientY };
      // PTT arms at 250ms — a shorter press is a tap (see micTap)
      holdArmRef.current = setTimeout(() => {
        holdArmRef.current = null;
        void pttDown();
      }, 250);
    },
    onPointerUp: () => {
      // tap = the arm timer never fired → no PTT state exists at all
      if (holdArmRef.current) micTap();
      else void pttUp();
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!holding) return;
      const dx = e.clientX - pttStartRef.current.x;
      // slide left arms the delete zone; slide back right disarms
      // (hysteresis so a shaky finger can't flicker the zone)
      if (dx < -24 && !pttCancelArmRef.current) {
        pttCancelArmRef.current = true;
        setPttCancelArm(true);
      } else if (dx > -8 && pttCancelArmRef.current) {
        pttCancelArmRef.current = false;
        setPttCancelArm(false);
      }
    },
    onPointerLeave: () => {
      // left before the arm threshold: that press is dead — a tap on the
      // way out must not fire on a lost pointerup
      if (holdArmRef.current) {
        clearHoldArm();
        return;
      }
      if (holding) pttCancel();
    },
    onPointerCancel: () => {
      clearHoldArm();
      if (holding) pttCancel();
    },
    onContextMenu: (e: React.MouseEvent<HTMLButtonElement>) => e.preventDefault(),
  };

  return (
    <main className="relative mx-auto flex h-dvh max-w-md flex-col overflow-hidden px-3">
      {/* header — the slug is the way into session settings (name / model /
          think / agent); busy dot stays pinned to the right of the name */}
      <header className="flex items-center justify-between gap-2 py-3">
        <Link
          href={`/session/${slug}/settings`}
          aria-label="session settings"
          className="min-w-0 flex-1 truncate text-sm hover:opacity-80"
        >
          {slug}
          {busy && <span className="oz-busy ml-2 text-[var(--oz-active)]">●</span>}
        </Link>
        {/* search is not a mode — the keyboard/hands-free switch is GONE:
            hands-free lives on the composer mic — tap to toggle, hold to
            talk (req 09-30) */}
        <div className="flex items-center gap-2">
          <button
            aria-label={searchOpen ? 'close search' : 'search transcript'}
            aria-pressed={searchOpen}
            onClick={() => setSearchOpen((o) => !o)}
            className={`rounded border p-1.5 ${
              searchOpen
                ? 'border-[var(--oz-active)] text-[var(--oz-active)]'
                : 'border-[var(--oz-border)] text-[var(--oz-dim)]'
            }`}
          >
            <PixelIcon name="search" size={16} />
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="mb-2 flex items-center gap-2 rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] px-2 py-1.5">
          <PixelIcon name="search" size={14} className="text-[var(--oz-dim)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setMatchIdx(0); // new query → start from the first hit again
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchOpen(false);
                e.currentTarget.blur();
              } else if (e.key === 'Enter') {
                e.preventDefault();
                setMatchIdx(safeIdx + (e.shiftKey ? -1 : 1));
              }
            }}
            placeholder="search transcript…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--oz-dim)]"
          />
          {query.trim() && (
            <span className="text-[10px] text-[var(--oz-dim)] tabular-nums">
              {matches.length ? `${safeIdx + 1}/${matches.length}` : 'no hits'}
            </span>
          )}
          <button
            aria-label="previous match"
            disabled={!matches.length}
            onClick={() => setMatchIdx(safeIdx - 1)}
            className="text-[var(--oz-dim)] disabled:opacity-40"
          >
            ↑
          </button>
          <button
            aria-label="next match"
            disabled={!matches.length}
            onClick={() => setMatchIdx(safeIdx + 1)}
            className="text-[var(--oz-dim)] disabled:opacity-40"
          >
            ↓
          </button>
          <button
            aria-label="close search"
            onClick={() => setSearchOpen(false)}
            className="text-[var(--oz-dim)]"
          >
            <PixelIcon name="close" size={12} />
          </button>
        </div>
      )}

      {error && <ErrorBox error={error} onDismiss={() => setError('')} slug={slug} />}

      {/* transcript */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          if (el.scrollTop <= 2) void loadOlder();
        }}
        className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain pb-2 pr-14"
      >
        {loadingOlder && (
          <div className="pt-1 text-center text-[10px] text-[var(--oz-dim)]">loading older…</div>
        )}
        {msgs.length === 0 && (
          <div className="pt-10 text-center text-xs text-[var(--oz-dim)]">
            empty session — type, hold the mic, or tap the side mic for hands-free
          </div>
        )}
        {msgs.map((m, i) => (
          <SessionMessage
            key={i}
            m={m}
            mi={i}
            hit={searchOpen && !!query.trim() && hitSet.has(i)}
            q={searchOpen ? query : ''}
            // still the newest message while the run is going = sitting in
            // the agent's queue — badge it until a reply lands after it
            queued={busy && !!m.queued}
            // swipe → steps into the past (opens the message BEFORE this
            // one); swipe ← back toward the present. Out-of-bounds swipes
            // are "already there" no-ops (newest ← = still no message)
            onOpenHistory={(mi, dir) => {
              const next = dir === 'older' ? mi - 1 : mi + 1;
              if (next < 0 || next >= msgs.length) return;
              setHistIdx(next);
            }}
          />
        ))}
        {busy && (
          <div className="flex items-center gap-3 text-xs text-[var(--oz-active)]">
            <span className="oz-busy">● working… {busySecs}s</span>
            <button
              onClick={abortGeneration}
              className="flex items-center gap-1 rounded border border-[var(--oz-danger)]/70 px-2.5 py-1 text-[var(--oz-danger)]"
            >
              <PixelIcon name="stop" size={12} /> stop
            </button>
          </div>
        )}

        {/* listen chip — anchored to the last message, in the text flow.
            Only when that message IS the assistant's (the chip plays it);
            hidden while the deck is active (fixed deck owns the controls). */}
        {speech.phase === 'idle' &&
          lastAssistant &&
          msgs.length > 0 &&
          msgs[msgs.length - 1] === lastAssistant && (
            <button
              onClick={() => {
                // a deliberately played reply counts as heard (req 09-30):
                // a later arrival must not auto-play it again
                if (lastAssistant.time) markHeard(slug, lastAssistant.time);
                startSpeech(lastAssistant.text, slug);
              }}
              className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-[var(--oz-border)] px-3 py-1.5 text-xs text-[var(--oz-dim)]"
            >
              <PixelIcon name="volume" size={12} /> listen
            </button>
          )}
      </div>

      {/* swipe-history browser — fixed overlay, one message at a time */}
      {histIdx !== null && msgs.length > 0 && (
        <MessageHistory
          msgs={msgs}
          index={histIdx}
          onIndex={setHistIdx}
          onClose={() => setHistIdx(null)}
        />
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1 pb-1">
          {attachments.map((a, i) => (
            <span
              key={i}
              className="flex items-center gap-1 rounded border border-[var(--oz-border)] px-2 py-1 text-xs"
            >
              {a.kind === 'image' && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.dataUrl} alt="" className="h-6 w-6 rounded object-cover" />
              )}
              <span className="max-w-28 truncate text-[var(--oz-dim)]">{a.name}</span>
              <button
                aria-label={`remove ${a.name}`}
                onClick={() => setAttachments((arr) => arr.filter((_, j) => j !== i))}
                className="text-[var(--oz-dim)]"
              >
                <PixelIcon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* tts deck — speak the last reply. Toggle: start (idle) / ■ stop
          (active — also during 'loading': a stalled synthesis must be
          user-stoppable, the Mac once never delivered audio, req 09-30). */}
      {speech.phase !== 'idle' && (
        <div className="flex justify-end pb-1.5">
          <button
            onClick={stopSpeech}
            className="rounded border border-[var(--oz-danger)]/60 px-3 py-1.5 text-xs text-[var(--oz-danger)]"
          >
            ■ stop
          </button>
        </div>
      )}

      {speech.phase === 'loading' && (
        <div className="mb-2 rounded border border-[var(--oz-success)]/50 bg-[var(--oz-surface)]">
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="flex gap-2.5">
              <span className="oz-tts-dot" />
              <span className="oz-tts-dot" style={{ animationDelay: '.18s' }} />
              <span className="oz-tts-dot" style={{ animationDelay: '.36s' }} />
            </div>
            <div className="text-[11px] tracking-widest text-[var(--oz-dim)]">synthesizing…</div>
          </div>
        </div>
      )}

      {(speech.phase === 'playing' || speech.phase === 'paused') && (
        <div className="mb-2 rounded border border-[var(--oz-success)]/50 bg-[var(--oz-surface)] px-3 py-2.5 shadow-lg">
          <div className="flex items-center gap-2">
            <span
              role="status"
              aria-label={speech.phase === 'paused' ? 'paused' : 'speaking'}
              className={`oz-eq ${speech.phase === 'paused' ? 'oz-eq-paused' : ''}`}
            >
              <i />
              <i />
              <i />
              <i />
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={`truncate text-[11px] ${
                  speech.phase === 'paused' ? 'text-[var(--oz-dim)]' : 'text-[var(--oz-success)]'
                }`}
              >
                {speech.phase === 'paused'
                  ? `paused · ${Math.round(speech.positionSec)}s / ${Math.round(speech.receivedSec)}s`
                  : `speaking · last reply · ${Math.round(speech.positionSec)}s / ~${Math.round(speech.totalEstSec)}s`}
              </div>
              <div className="truncate text-[10px] text-[var(--oz-dim)]">
                {Math.round(speech.receivedSec)}s synthesized
              </div>
            </div>
          </div>
          {/* seek bar — drag anywhere: back/within-cache is instant, forward
              into un-synthesized text synthesizes first (stripes = not ready) */}
          <div
            ref={seekRef}
            className="oz-seek"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setSeekFrac(seekFracFromEvent(e));
            }}
            onPointerMove={(e) => {
              if (seekFrac !== null) setSeekFrac(seekFracFromEvent(e));
            }}
            onPointerUp={(e) => {
              seekSpeech(seekFracFromEvent(e));
              setSeekFrac(null);
            }}
            onPointerCancel={() => setSeekFrac(null)}
          >
            <div className="oz-seek-track">
              <div
                className="oz-seek-fill"
                style={{
                  width: `${(seekFrac ?? Math.min(1, speech.positionSec / Math.max(speech.totalEstSec, 0.5))) * 100}%`,
                }}
              />
            </div>
            <div
              className="oz-seek-thumb"
              style={{
                left: `${(seekFrac ?? Math.min(1, speech.positionSec / Math.max(speech.totalEstSec, 0.5))) * 100}%`,
              }}
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => (speech.phase === 'paused' ? resumeSpeech() : pauseSpeech())}
              className="rounded border border-[var(--oz-success)]/60 bg-[var(--oz-success)]/10 px-4 py-1.5 text-sm text-[var(--oz-success)]"
              aria-label={speech.phase === 'paused' ? 'resume speech' : 'pause speech'}
            >
              {speech.phase === 'paused' ? '▶' : '⏸'}
            </button>
            <span className="flex-1" />
            <div className="flex overflow-hidden rounded border border-[var(--oz-success)]/50">
              {[1, 1.5, 2].map((r) => (
                <button
                  key={r}
                  onClick={() => rateSpeech(r)}
                  className={`px-2.5 py-1.5 text-xs ${
                    speech.rate === r
                      ? 'bg-[var(--oz-success)]/15 text-[var(--oz-success)]'
                      : 'text-[var(--oz-dim)]'
                  }`}
                >
                  {r}x
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {mode === 'free' ? (
        /* hands-free: the composer (attach / text input / push-to-talk) makes
           no sense while the mic is always hot — show the live speaking
           equalizer + session timer instead. The equalizer is TAP-TO-SEND
           (req 09-30): tapping it commits the buffered turn, same as saying
           "over" — keyword and tap both stay. */
        <div className="flex items-center gap-3 border-t border-[var(--oz-border)] py-3">
          <button
            data-testid="free-strip"
            aria-label="send what you said"
            onClick={() => void commitFreeTurn()}
            className={`flex min-w-0 flex-1 items-end justify-center gap-1 rounded border bg-[var(--oz-surface)] px-3 py-2 transition-colors ${
              voiceState === 'ready' && freeCycle === 'listening'
                ? 'cursor-pointer border-[var(--oz-success)]/60 active:bg-[var(--oz-surface-hover)]'
                : 'cursor-default border-[var(--oz-border)]'
            }`}
          >
            {voiceState !== 'ready' ? (
              <span className="oz-ptt-hold flex-1 self-center text-center text-[11px] text-[var(--oz-dim)]">
                connecting…
              </span>
            ) : freeCycle !== 'listening' ? (
              <span className="flex-1 self-center text-center text-[11px] text-[var(--oz-dim)]">
                working — mic paused
              </span>
            ) : (
              freeLevels.map((l, i) => (
                <span
                  key={i}
                  className="w-1.5 bg-[var(--oz-success)] transition-[height] duration-75"
                  style={{ height: `${Math.max(3, Math.round(l * 22))}px` }}
                />
              ))
            )}
          </button>
          <span
            aria-label="hands-free duration"
            className="self-center text-[11px] text-[var(--oz-dim)] tabular-nums"
          >
            {Math.floor(freeSecs / 60)}:{String(freeSecs % 60).padStart(2, '0')}
          </span>
          {/* the exit — same slot, same size as text-mode's send/mic button
              (req 09-30: 'same height/width as the send/mic btn same place').
              Red with a filled square: reads as stop. */}
          <button
            data-testid="free-exit"
            aria-label="leave hands-free"
            onClick={toggleHandsFree}
            className="flex flex-none items-center justify-center self-center rounded border border-[var(--oz-danger)]/60 px-3 py-2 text-[var(--oz-danger)] select-none active:bg-[var(--oz-surface-hover)]"
            style={{ touchAction: 'manipulation' }}
          >
            <span aria-hidden className="h-3.5 w-3.5 rounded-[2px] bg-[var(--oz-danger)]" />
          </button>
        </div>
      ) : (
        /* text input — always available */
        <>
          {/* composer history indicator — in flow (a floating chip overlapped
              the listen button at the transcript's bottom edge) */}
          {histChip && (
            <div
              data-testid="hist-chip"
              className="pb-0.5 text-[10px] text-[var(--oz-dim)] tabular-nums"
            >
              {histChip}
            </div>
          )}
          <div className="flex items-end gap-2 border-t border-[var(--oz-border)] py-3">
          {/* single paper-clip button — opens the phone's photo/camera picker
            (accept=image/*); files ride along when picked from there */}
          <button
            aria-label="attach"
            onClick={() => photoInputRef.current?.click()}
            className="rounded border border-[var(--oz-border)] px-2.5 py-2 text-[var(--oz-dim)]"
          >
            <PixelIcon name="attachment" size={16} />
          </button>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addAttachments(e.target.files);
              e.currentTarget.value = '';
            }}
          />
          {holding ? (
            <div
              aria-label={voiceState === 'ready' ? 'listening' : 'connecting'}
              role="status"
              className={`flex min-w-0 flex-1 items-end justify-center gap-1 rounded border bg-[var(--oz-surface)] px-3 py-2 transition-colors ${
                pttCancelArm
                  ? 'border-[var(--oz-danger)] text-[var(--oz-danger)]'
                  : voiceState === 'ready'
                    ? 'border-[var(--oz-success)]/60'
                    : 'border-[var(--oz-border)]'
              }`}
            >
              {voiceState !== 'ready' ? (
                // room still dialing in (first press pays the connect cost) —
                // pulse until the equalizer can take over
                <span className="oz-ptt-hold flex-1 self-center text-center text-[11px] text-[var(--oz-dim)]">
                  connecting…
                </span>
              ) : (
                <>
                  {pttCancelArm ? (
                    <span className="flex-1 self-center text-center text-[11px] tracking-widest uppercase">
                      release to delete
                    </span>
                  ) : (
                    <span
                      aria-label="hold duration"
                      className="mr-1 self-center text-[11px] text-[var(--oz-dim)] tabular-nums"
                    >
                      {Math.floor(pttSecs / 60)}:{String(pttSecs % 60).padStart(2, '0')}
                    </span>
                  )}
                  {pttLevels.map((l, i) => (
                    <span
                      key={i}
                      className={`w-1.5 transition-[height] duration-75 ${
                        pttCancelArm ? 'bg-[var(--oz-danger)]' : 'bg-[var(--oz-success)]'
                      }`}
                      style={{ height: `${Math.max(3, Math.round(l * 22))}px` }}
                    />
                  ))}
                </>
              )}
            </div>
          ) : (
            <textarea
              ref={(el) => {
                inputRef.current = el;
                taSwipeRef(el);
              }}
              value={input}
              rows={1}
              onChange={(e) => {
                // manual edit ends history browsing — this is the draft now
                liveEdit(e.target.value);
                try {
                  if (slug) localStorage.setItem('oz-draft:' + slug, e.target.value);
                } catch {
                  /* private mode */
                }
                autogrow(e.target);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
                  e.preventDefault();
                  sendText();
                } else if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                  // shell-style recall: caret on the first line → step back
                  // through the user's own sent messages
                  const el = e.currentTarget;
                  const onFirstLine = !el.value.slice(0, el.selectionStart ?? 0).includes('\n');
                  if (onFirstLine && sentHistory.length > 0) {
                    e.preventDefault();
                    recall('older');
                  }
                } else if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                  // forward again; past the newest restores the parked draft
                  const el = e.currentTarget;
                  const onLastLine = !el.value.slice(el.selectionEnd ?? el.value.length).includes('\n');
                  if (onLastLine && histPosRef.current !== null) {
                    e.preventDefault();
                    recall('newer');
                  }
                }
              }}
              placeholder="message…"
              className="min-w-0 flex-1 resize-none rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] px-3 py-2 text-sm leading-snug outline-none placeholder:text-[var(--oz-dim)]"
              style={{ maxHeight: 96 }}
            />
          )}
          {/* discord-style rightmost button: mic (hold to talk) when empty,
            send as soon as there's something to send */}
          {input.trim() || attachments.length > 0 ? (
            <button
              onClick={sendText}
              aria-label="send"
              className="rounded border border-[var(--oz-success)]/60 px-3 py-2 text-sm text-[var(--oz-success)]"
            >
              <PixelIcon name="send" size={16} />
            </button>
          ) : (
            <button
              {...micHoldHandlers}
              data-testid="composer-mic"
              aria-label="push to talk"
              className={`rounded border px-3 py-2 text-sm select-none ${
                holding
                  ? 'oz-ptt-hold border-[var(--oz-success)]'
                  : 'border-[var(--oz-border)] text-[var(--oz-dim)]'
              } ${voiceState === 'connecting' ? 'opacity-50' : ''}`}
              style={{ touchAction: 'none' }}
            >
              {/* the mic button itself never changes — the recording pill is
                what turns red when the delete zone is armed. A quick TAP is
                the hands-free toggle (req 09-30), a hold talks. */}
              <PixelIcon name="mic" size={16} />
            </button>
          )}
          </div>
        </>
      )}

      {mode === 'free' && (
        <div className="flex items-center justify-center gap-3 py-3 text-xs">
          <span
            role="status"
            data-testid="free-phase"
            data-cycle={freeCycle}
            className={`${
              freeCycle === 'processing' ? 'animate-pulse text-[var(--oz-active)]' : 'text-[var(--oz-success)]'
            }`}
          >
            {voiceState !== 'ready'
              ? '● hands-free — connecting…'
              : freeCycle === 'processing'
                ? speech.phase === 'idle'
                  ? '● working on it — mic paused…'
                  : '● speaking — mic returns when it ends'
                : '● hands-free — say “over” or tap the bars to send'}
          </span>
        </div>
      )}

      {/* the mid-right floating mic-switch is GONE (req 09-30): the composer
          mic is the one voice control — tap toggles hands-free, hold talks. */}
    </main>
  );
}

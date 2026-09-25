'use client';

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Room, RoomEvent, Track, createAudioAnalyser } from 'livekit-client';
import { PixelIcon } from '@/components/pixel-icon';
import { type Msg, SessionMessage } from '@/components/session-message';
import { diagEvent } from '@/lib/diag';
import { clearAsked, ensureNotifyPermission, markAsked, notifyReply } from '@/lib/notify';
import { PENDING_TTL_MS } from '@/lib/pending-ttl';
import { markRead } from '@/lib/read';

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
  searchParams: Promise<{ id?: string }>;
}) {
  const [slug, setSlug] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
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
  const safeIdx = matches.length ? ((matchIdx % matches.length) + matches.length) % matches.length : 0;
  const hitSet = useMemo(() => new Set(matches), [matches]);
  // jump to the active match whenever it changes (also lands on first hit
  // right after typing) — search scrolls free of the bottom-stick logic
  useEffect(() => {
    if (!matches.length) return;
    document
      .querySelector(`[data-mi="${matches[safeIdx]}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [matches, safeIdx]);
  useEffect(() => setMatchIdx(0), [query]);

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
  const totalRef = useRef(0);
  const runBaseTotalRef = useRef(0);
  // definitive "run in flight" from the proxy (its async POST resolves only
  // when the run finishes) — immune to long between-steps thinking
  const liveRef = useRef(false);
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
          const fresh: Msg[] = await r.json();
          const totalCount = Number(r.headers.get('X-Total-Count') || fresh.length);
          setTotal(totalCount);
          totalRef.current = totalCount;
          const st = r.headers.get('X-Run-State') || '';
          liveRef.current = r.headers.get('X-Run-Live') === '1';
          const liveSinceMs = Number(r.headers.get('X-Run-Live-Since') || 0);
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
            // prompts bypass the proxy so their only trace is the transcript
            const streamingStep = st.endsWith('|0|assistant');
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
      if (
        runStreakRef.current >= 2 &&
        runStateRef.current.split('|')[1] !== '0' &&
        totalRef.current > runBaseTotalRef.current &&
        !liveRef.current
      ) {
        diagEvent('busy', `clear ${slug} after ${sec}s`);
        setBusy(false);
        busyBeatRef.current = 0;
        runStreakRef.current = 0;
        clearAsked(slug);
        if (document.hidden) void notifyReply(slug);
        return;
      }
      // wedge guard: 30s busy, NO live run, and the LAST raw message is
      // still the user's own prompt → the runner never picked the message
      // up (hung earlier run, dead queue). Abort so the session un-wedges;
      // the prompt stays in the transcript, user can resend.
      if (
        !wedgeFiredRef.current &&
        sec >= 30 &&
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
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  async function ensureVoice(): Promise<Room> {
    if (roomRef.current && voiceState === 'ready') return roomRef.current;
    if (voicePromiseRef.current) return voicePromiseRef.current;
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
        // self-heal with a fresh token (e.g. the phone slept past the token
        // TTL and the server dropped the room); a live room implies voice
        // intent since PTT lazily connects from any mode
        if (!unmountedRef.current) reconnectVoice();
      });
      room.on(RoomEvent.MediaDevicesError, (e: Error) => diagEvent('voice-fail', String(e)));
      diagEvent('voice', 'connecting signal…');
      await withTimeout(room.connect(d.serverUrl, d.participantToken), 12_000, 'signal');
      diagEvent('voice', 'connected, mic stays muted until a mode/handler turns it on');
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

  async function switchMode(next: Mode) {
    if (next === mode) return;
    setError('');
    setMode(next); // optimistic — bottom UX must react immediately
    // sync the ref NOW: the disconnect below fires RoomEvent.Disconnected
    // asynchronously and the self-heal must already see the new mode, or it
    // reconnects a room the user just left (socket that never closes)
    modeRef.current = next;
    try {
      if (next === 'text') {
        // mute is not enough: the room keeps the capture device open, so the
        // phone still shows "mic in use". Release it for real — ensureVoice()
        // reconnects lazily (fresh token) when a voice mode is picked again.
        const room = roomRef.current;
        roomRef.current = null;
        voicePromiseRef.current = null;
        setVoiceState('off');
        diagEvent('voice', 'released (keyboard mode)');
        await room?.disconnect();
      } else {
        // hands-free: mic stays on, VAD drives turns (agent auto-commits).
        // PTT from the composer works in both modes (mic mutes on release).
        await ensureVoice();
        await mic(true);
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
      if (!pttWantRef.current || modeRef.current === 'text') {
        // finger lifted (or mode switched) while the room was still dialing
        // in — don't leave a live room + hot mic behind: tear it down, the
        // next press reconnects
        await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
        if (roomRef.current === room) roomRef.current = null;
        voicePromiseRef.current = null;
        void room.disconnect().catch(() => {});
        setVoiceState('off');
        setHolding(false);
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
    if (!room) return;
    if (discard) {
      // released inside the delete zone — drop the buffered turn
      if (modeRef.current !== 'free') await mic(false);
      pttDiscardRpc();
      return;
    }
    if (modeRef.current !== 'free') await mic(false); // hands-free keeps listening
    stickRef.current = true;
    setBusy(true); // cleared when the run state settles (see poller)
    armRunWatch();
    try {
      const agent = Array.from(room.remoteParticipants.values())[0];
      if (agent) {
        const res = await room.localParticipant.performRpc({
          destinationIdentity: agent.identity,
          method: 'commit_turn',
          payload: '{}',
          responseTimeout: 10_000,
        });
        // agent answered but its session is dead (stale room) → reconnect
        if (res && res !== 'ok') throw new Error(res);
      }
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
      reconnectVoice();
      return;
    }
  }

  // live mic equalizer (PTT pill + hands-free strip) — see useMicLevels
  const pttLevels = useMicLevels(holding, roomRef);
  const freeLevels = useMicLevels(mode === 'free' && voiceState === 'ready', roomRef);

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
    // per session) — stopping is a separate, explicit action
    if (!images.length && !files.length && roomRef.current && voiceState === 'ready') {
      // voice context: through the room so the agent speaks the reply
      // (attachments must take the REST path — the room only carries text)
      setBusy(true);
      armRunWatch();
      addEcho(text);
      try {
        await roomRef.current.localParticipant.sendText(text, { topic: 'lk.chat' });
      } catch (e) {
        setError(`send failed: ${e}`);
        setBusy(false);
      }
      return;
    }
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
      } else {
        addEcho(text, images);
      }
      await loadMsgs();
    } catch {
      setError('send failed');
      setInput((prev) => (prev.trim() ? prev : text)); // draft back, no clobber
      setBusy(false);
    }
  }

  const segBtn = (m: Mode, icon: 'keyboard' | 'mic' | 'infinity', label: string) => (
    <button
      aria-label={label}
      onClick={() => switchMode(m)}
      className={`flex-1 rounded px-2 py-1.5 text-xs ${
        mode === m ? 'bg-[var(--oz-surface-hover)] text-[var(--oz-active)]' : 'text-[var(--oz-dim)]'
      }`}
    >
      <span className="mx-auto block w-fit">
        <PixelIcon name={icon} size={16} />
      </span>
    </button>
  );

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col overflow-hidden px-3">
      {/* header */}
      <header className="flex items-center justify-between gap-2 py-3">
        <div className="min-w-0 flex-1 truncate text-sm">
          {slug}
          {busy && <span className="oz-busy ml-2 text-[var(--oz-active)]">●</span>}
        </div>
        {/* search is not a mode — own button, visually split from the
            keyboard/hands-free toggle (gap-2) */}
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
          <div className="flex items-center gap-1 rounded border border-[var(--oz-border)] p-0.5">
            {segBtn('text', 'keyboard', 'text mode')}
            {segBtn('free', 'infinity', 'hands-free')}
          </div>
        </div>
      </header>

      {searchOpen && (
        <div className="mb-2 flex items-center gap-2 rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] px-2 py-1.5">
          <PixelIcon name="search" size={14} className="text-[var(--oz-dim)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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

      {error && (
        <div className="mb-2 rounded border border-[var(--oz-danger)]/60 px-3 py-2 text-xs text-[var(--oz-danger)]">
          {error}{' '}
          <button onClick={() => setError('')} className="underline">
            dismiss
          </button>
        </div>
      )}

      {/* transcript */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          if (el.scrollTop <= 2) void loadOlder();
        }}
        className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain pb-2"
      >
        {loadingOlder && (
          <div className="pt-1 text-center text-[10px] text-[var(--oz-dim)]">loading older…</div>
        )}
        {msgs.length === 0 && (
          <div className="pt-10 text-center text-xs text-[var(--oz-dim)]">
            empty session — type, hold the mic, or go hands-free
          </div>
        )}
        {msgs.map((m, i) => (
          <SessionMessage
            key={i}
            m={m}
            mi={i}
            hit={searchOpen && !!query.trim() && hitSet.has(i)}
            // still the newest message while the run is going = sitting in
            // the agent's queue — badge it until a reply lands after it
            queued={busy && m.role === 'user' && i === msgs.length - 1}
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
      </div>

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

      {mode === 'free' ? (
        /* hands-free: the composer (attach / text input / push-to-talk) makes
           no sense while the mic is always hot — show the live speaking
           equalizer + session timer instead */
        <div className="flex items-center gap-3 border-t border-[var(--oz-border)] py-3">
          <div
            role="status"
            aria-label={voiceState === 'ready' ? 'listening' : 'connecting'}
            className={`flex min-w-0 flex-1 items-end justify-center gap-1 rounded border bg-[var(--oz-surface)] px-3 py-2 transition-colors ${voiceState === 'ready' ? 'border-[var(--oz-success)]/60' : 'border-[var(--oz-border)]'}`}
          >
            {voiceState !== 'ready' ? (
              <span className="oz-ptt-hold flex-1 self-center text-center text-[11px] text-[var(--oz-dim)]">
                connecting…
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
          </div>
          <span
            aria-label="hands-free duration"
            className="self-center text-[11px] text-[var(--oz-dim)] tabular-nums"
          >
            {Math.floor(freeSecs / 60)}:{String(freeSecs % 60).padStart(2, '0')}
          </span>
        </div>
      ) : (
        /* text input — always available */
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
              ref={inputRef}
              value={input}
              rows={1}
          onChange={(e) => {
            setInput(e.target.value);
            try {
              if (slug) localStorage.setItem('oz-draft:' + slug, e.target.value);
            } catch {
              /* private mode */
            }
            autogrow(e.target);
          }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendText();
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
              aria-label="push to talk"
              onPointerDown={(e) => {
                e.preventDefault();
                pttDown(e);
              }}
              onPointerUp={() => pttUp()}
              onPointerMove={(e) => {
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
              }}
              onPointerLeave={() => holding && pttCancel()}
              onPointerCancel={() => holding && pttCancel()}
              onContextMenu={(e) => e.preventDefault()}
              className={`rounded border px-3 py-2 text-sm select-none ${
                holding
                  ? 'oz-ptt-hold border-[var(--oz-success)]'
                  : 'border-[var(--oz-border)] text-[var(--oz-dim)]'
              } ${voiceState === 'connecting' ? 'opacity-50' : ''}`}
              style={{ touchAction: 'none' }}
            >
              {/* the mic button itself never changes — the recording pill is
                what turns red when the delete zone is armed */}
              <PixelIcon name="mic" size={16} />
            </button>
          )}
        </div>
      )}

      {mode === 'free' && (
        <div className="py-3 text-center text-xs text-[var(--oz-success)]">
          ● hands-free — just talk, pauses end your turn
        </div>
      )}
    </main>
  );
}

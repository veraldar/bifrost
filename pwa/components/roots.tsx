'use client';

/** THE ROOTS (MAINFRAME-C, 10-26) — the front page's ground: the tree's
 *  roots, full width at the bottom, and they ARE MAIN (the root is the
 *  tree's brain; MAIN is your line to it). One tree on the page: the band
 *  on top is the crown (the work), the list is the trunk, this is the roots.
 *    press  amber in the same frame, "heard" (a class flip, no React round
 *           trip — the door's law)
 *    tap    (let go inside 0.3 s) → MAIN opens, as the corner door did
 *    hold   (past 0.3 s) → hands-free with MAIN starts right here: talk,
 *           let go = sent, the reply is spoken here, the mic comes back;
 *           "over" sends the next, the ■ key (or "over and out") ends it.
 *           Slide off (or Esc) = drop: nothing sent, as if never held
 *  Keyboard: focus the roots — Enter = tap, Space = press (held = talk).
 *  Voice tests on (settings): the roots talk to the voice-test room.
 *  The voice machinery (lib/roots-voice → livekit) loads lazily: never on
 *  the front page's first load. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { StopSquare } from '@/components/line-icon';
import { YggRoots } from '@/components/ygg';
import { diagEvent } from '@/lib/diag';
import { lastRead } from '@/lib/read';
import type { RootsLine, RootsSnap } from '@/lib/roots-voice';
import { slugify } from '@/lib/slug';
import { FIRST_TURN_KEY, MAIN_SLUG, TF_SHRINK_KEY, isOnboardPrompt } from '@/lib/tree-first';
import { VOICE_TEST_SLUG, voiceTestOn } from '@/lib/voice-test';

/** past this, a press is a hold (C: 0.3 s — a tap opens MAIN) */
export const HOLD_MS = 300;
/** the open-question circle decays like the list's (page.tsx) */
const OPEN_QUESTION_TTL_MS = 48 * 60 * 60 * 1000;
/** device-local: this device held the roots once — the hint retires */
const HELD_KEY = 'bifrost-roots-held';
/** device-local: front-page opens that showed the hint — three, then MAIN's
 *  own line takes the roots back even if the hold was never tried */
const HINT_KEY = 'bifrost-roots-hint';
const HINT_VISITS = 3;

const OFF: RootsSnap = { phase: 'off', free: false, slug: '', reply: '', note: '' };

export type RootsRow = {
  id: string;
  title: string;
  preview: string;
  lastRole?: string;
  lastAt?: number;
  lastHasQ?: boolean;
  pending?: boolean;
};

type Gate = '' | 'first' | 'denied' | 'prompt';
type Press = {
  id: number | 'key';
  at: number;
  timer: ReturnType<typeof setTimeout>;
  armed: boolean;
  drop: boolean;
  gate: Gate;
};

// the module (and livekit with it) — one load per page, shared by the idle
// warm-up and the first hold
let lineP: Promise<RootsLine> | null = null;
function loadLine(): Promise<RootsLine> {
  if (!lineP) {
    lineP = import('@/lib/roots-voice').then((m) => m.rootsLine());
    lineP.catch(() => (lineP = null));
  }
  return lineP.then((l) => (l.gone ? ((lineP = null), loadLine()) : l));
}

async function micPermission(): Promise<PermissionState | 'unknown'> {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return p.state;
  } catch {
    return 'unknown'; // no Permissions API for the mic (Firefox, old Safari)
  }
}

export function Roots({
  main,
  branchWorking,
  onSettled,
  onWorking,
}: {
  /** MAIN's row from the session list (or voice-test's, with voice tests on) */
  main?: RootsRow;
  /** a branch (any session but MAIN) works — the crown and the roots then
   *  share the band's 8 s clock: one thought on the screen at a time */
  branchWorking: boolean;
  /** a roots talk settled — the list refetches (MAIN's row is fresh) */
  onSettled: () => void;
  /** the roots walk (MAIN works): the band gives them its odd slots */
  onWorking?: (on: boolean) => void;
}) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<HTMLSpanElement>(null);
  const pressRef = useRef<Press | null>(null);
  const permRef = useRef<Promise<PermissionState | 'unknown'> | null>(null);
  const [line, setLine] = useState<RootsLine | null>(null);
  const lineRef = useRef<RootsLine | null>(null); // the handlers' live view
  const [armed, setArmed] = useState<Gate | 'hold' | ''>('');
  const [drop, setDrop] = useState(false);
  const [note, setNote] = useState('');
  const [vt, setVt] = useState(false);
  // the hint ("hold to talk · tap to open") — a device that never held,
  // for its first few visits: one hold phrase per surface (tree-door.md)
  const [hint, setHint] = useState(false);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const snap = useSyncExternalStore(
    useCallback((f: () => void) => (line ? line.subscribe(f) : () => {}), [line]),
    () => (line ? line.get() : OFF),
    () => OFF
  );

  useEffect(() => {
    setVt(voiceTestOn());
    let voice = false;
    try {
      const shown = Number(localStorage.getItem(HINT_KEY) || 0);
      if (!localStorage.getItem(HELD_KEY) && shown < HINT_VISITS) {
        setHint(true);
        localStorage.setItem(HINT_KEY, String(shown + 1));
      }
      voice = !!localStorage.getItem(FIRST_TURN_KEY);
    } catch {
      /* private mode */
    }
    // a device that talks (its first voice turn is done): the voice module
    // warms while the page idles — the first hold does not wait for it
    if (!voice) return;
    const ric = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1_500));
    const cic = window.cancelIdleCallback ?? window.clearTimeout;
    const id = ric(() => void loadLine().catch(() => {}), { timeout: 6_000 });
    return () => cic(id);
  }, []);

  // the line lives with the page: leaving takes the room and the voice along
  useEffect(() => {
    if (!line) return;
    line.onSettled = () => settledRef.current();
    line.setBars(barsRef.current);
    return () => line.dispose();
  }, [line]);

  // the first time, after the door: the roots grow up from the bottom edge
  // (the corner door's one-shot shrink, retargeted) — once, never again
  useLayoutEffect(() => {
    let play = false;
    try {
      play = sessionStorage.getItem(TF_SHRINK_KEY) !== null;
      sessionStorage.removeItem(TF_SHRINK_KEY);
    } catch {
      /* private mode — the roots just stand */
    }
    if (play) rootRef.current?.classList.add('grow');
  }, []);

  const slugNow = () => (voiceTestOn() ? VOICE_TEST_SLUG : MAIN_SLUG);

  function say(n: string, ms = 4_500) {
    setNote(n);
    window.setTimeout(() => setNote((x) => (x === n ? '' : x)), ms);
  }

  function open() {
    rootRef.current?.classList.add('open');
    diagEvent('roots', 'tap → MAIN');
    router.push(`/session/${MAIN_SLUG}`);
  }

  // ── press: amber this frame; the timer decides tap or hold ──────────────
  function press(id: number | 'key') {
    if (pressRef.current) return;
    rootRef.current?.classList.add('heard'); // no React round-trip: amber now
    const at = performance.now();
    pressRef.current = {
      id,
      at,
      timer: setTimeout(arm, HOLD_MS),
      armed: false,
      drop: false,
      gate: '',
    };
    // what the hold will need, asked now (both answer well inside 0.3 s)
    permRef.current = micPermission();
    void loadLine().catch(() => {});
  }

  async function arm() {
    const p = pressRef.current;
    if (!p) return;
    p.armed = true;
    let first = false;
    try {
      first = !localStorage.getItem(FIRST_TURN_KEY);
    } catch {
      /* private mode: treat as proven */
    }
    // the first voice turn happens inside MAIN (its card proves the STT on
    // this device) — the list can't host that card
    if (first) {
      p.gate = 'first';
      setArmed('first');
      return;
    }
    const perm = await (permRef.current ?? micPermission());
    if (pressRef.current !== p) return;
    if (perm === 'denied') {
      p.gate = 'denied';
      setArmed('denied');
      return;
    }
    if (perm === 'prompt') {
      // the browser asks once — never mid-turn (the prompt steals the
      // finger): ask now, the next hold talks
      p.gate = 'prompt';
      setArmed('prompt');
      navigator.mediaDevices
        ?.getUserMedia({ audio: true })
        .then((st) => {
          st.getTracks().forEach((t) => t.stop());
          say('the mic is allowed — hold again to talk');
        })
        .catch(() => say('the mic is blocked — allow it in the site settings', 8_000));
      return;
    }
    setArmed('hold');
    try {
      localStorage.setItem(HELD_KEY, '1');
    } catch {
      /* private mode */
    }
    setHint(false);
    const l = await loadLine().catch(() => null);
    if (!l) {
      say('the voice could not load — tap to open main', 8_000);
      return;
    }
    lineRef.current = l;
    setLine(l);
    const to = slugNow();
    // the session id pins the transcript reads (herdr §1.4) — only when the
    // row the page handed over really is the room being talked to
    const pin = main && slugify(main.title || '') === to ? main.id : '';
    void l.holdStart(to, pin, p.at);
    // let go while the module was still loading: the hold still started
    // hands-free — its release lands now
    if (pressRef.current !== p) void l.holdEnd(p.drop);
  }

  function release(cancel: boolean) {
    const p = pressRef.current;
    if (!p) return;
    pressRef.current = null;
    clearTimeout(p.timer);
    if (cancel) p.drop = true; // a cancel is a drop, also for arm()'s handover
    const el = rootRef.current;
    el?.classList.remove('heard', 'drop');
    setDrop(false);
    setArmed('');
    if (!p.armed) {
      // the tap window: let go = MAIN opens; slid off = nothing at all
      if (!cancel) open();
      return;
    }
    if (p.gate === 'first') {
      if (!cancel) open(); // the first talk happens in MAIN, with its card
      return;
    }
    if (p.gate === 'denied') {
      say('the mic is blocked — allow it in the site settings', 8_000);
      return;
    }
    if (p.gate === 'prompt') return; // the prompt answers for itself
    const l = lineRef.current;
    if (l && !l.gone) void l.holdEnd(p.drop);
    // (no line yet: arm() hands the release over when the module lands)
  }

  function slide(clientX: number, clientY: number) {
    const p = pressRef.current;
    const el = rootRef.current;
    if (!p || !el) return;
    const r = el.getBoundingClientRect();
    const out =
      clientY < r.top - 16 ||
      clientX < r.left - 16 ||
      clientX > r.right + 16 ||
      clientY > r.bottom + 16;
    if (!p.armed) {
      if (out) release(true); // slid off inside the tap window: nothing happens
      return;
    }
    if (out === p.drop) return;
    p.drop = out; // slide back in: the talk continues
    el.classList.toggle('drop', out);
    setDrop(out);
  }

  // ── what the roots say ────────────────────────────────────────────────────
  const phase = snap.phase;
  const row = main;
  const slug = vt ? VOICE_TEST_SLUG : MAIN_SLUG;
  const unread =
    !!row && row.lastRole === 'assistant' && (row.lastAt || 0) > lastRead(slug) && !row.pending;
  const openQ = unread && !!row?.lastHasQ && Date.now() - (row?.lastAt || 0) < OPEN_QUESTION_TTL_MS;
  const voiceOn = phase !== 'off';
  // ONE state token, as in MAIN: heard (amber) · working (green walk) ·
  // speaking (green breath) · replied (the answer climbed) · idle · drop
  const s = drop
    ? 'drop'
    : armed || phase === 'opening' || phase === 'talk' || phase === 'listening'
      ? 'heard'
      : phase === 'working'
        ? 'working'
        : phase === 'speaking'
          ? 'speaking'
          : row?.pending
            ? 'working'
            : unread
              ? 'replied'
              : 'idle';
  const words = drop
    ? 'drop · let go and nothing is sent'
    : armed === 'first'
      ? 'your first talk is inside main · let go to open it'
      : armed === 'denied'
        ? 'the mic is blocked — allow it in the site settings'
        : armed === 'prompt'
          ? 'allow the mic · then hold again'
          : snap.note || note
            ? snap.note || note
            : phase === 'opening'
              ? 'heard · opening the mic — talk when the bars move'
              : phase === 'talk'
                ? 'heard · talk · let go to send'
                : phase === 'listening'
                  ? 'listening · say “over” to send · ■ ends it'
                  : phase === 'working'
                    ? 'sent · awaiting answer…'
                    : phase === 'speaking'
                      ? snap.reply || 'speaking…'
                      : armed === 'hold'
                        ? 'heard'
                        : row?.pending
                          ? 'awaiting answer…'
                          : row && isOnboardPrompt(row.preview || '')
                            ? 'setup'
                            : hint && !unread
                              ? 'hold to talk · tap to open'
                              : row?.preview || 'your main conversation';
  // what a screen reader hears when the voice moves (the row text is the label)
  const spoken =
    phase === 'talk'
      ? 'heard — talk now'
      : phase === 'listening'
        ? 'listening'
        : phase === 'working'
          ? 'sent — working'
          : phase === 'speaking'
            ? 'speaking the reply'
            : snap.note || note || (drop ? 'release drops it' : '');
  const glyph =
    s === 'working' ? (
      <span className="d oz-breathe" aria-hidden="true">
        ●
      </span>
    ) : s === 'speaking' ? (
      <span className="d" aria-hidden="true">
        ▸
      </span>
    ) : s === 'replied' ? (
      <span className="d" aria-hidden="true">
        {openQ ? '○' : '●'}
      </span>
    ) : null;
  const walking = s === 'working';
  useEffect(() => onWorking?.(walking), [walking, onWorking]);
  const name = vt ? 'voice-test' : 'main';
  const showStop = snap.free || phase === 'working' || phase === 'speaking';

  return (
    <div
      ref={rootRef}
      className="oz-roots oz-ygg"
      data-testid="roots"
      data-s={s}
      data-phase={phase}
      data-free={snap.free ? '' : undefined}
      data-armed={armed || undefined}
      data-unread={unread ? '' : undefined}
      data-vt={vt ? '' : undefined}
      data-shared={s === 'working' && branchWorking ? '' : undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.remove('grow');
      }}
    >
      <Link
        href={`/session/${MAIN_SLUG}`}
        className="oz-roots-hit"
        data-testid="roots-hit"
        aria-label={`${name} — tap to open, hold to talk`}
        aria-describedby="roots-say"
        draggable={false}
        onPointerDown={(e) => {
          // the main button only — middle / ctrl / meta clicks stay links
          if (e.button !== 0 || !e.isPrimary || e.ctrlKey || e.metaKey || e.shiftKey) return;
          try {
            // the press keeps its pointer: a slide off is seen, a drop decided
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* the pointer is already gone — the press still counts */
          }
          press(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (pressRef.current?.id === e.pointerId) slide(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          if (pressRef.current?.id === e.pointerId) release(false);
        }}
        onPointerCancel={(e) => {
          if (pressRef.current?.id === e.pointerId) release(true);
        }}
        onClick={(e) => {
          // a pointer press already decided (tap = open, hold = talk); the
          // keyboard's Enter (detail 0) and modified clicks stay plain links
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          if (e.detail !== 0) e.preventDefault();
          else {
            rootRef.current?.classList.add('open');
            diagEvent('roots', 'Enter → MAIN');
          }
        }}
        onKeyDown={(e) => {
          if (e.key === ' ') {
            e.preventDefault(); // no page scroll: Space is the press
            if (!e.repeat) press('key');
          } else if (e.key === 'Escape' && pressRef.current) {
            e.preventDefault();
            release(true); // the keyboard's slide-off
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' && pressRef.current?.id === 'key') {
            e.preventDefault();
            release(false);
          }
        }}
        onBlur={() => {
          if (pressRef.current?.id === 'key') release(true);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <YggRoots />
        <span className="lbl">
          <span className="nm" data-testid="roots-name">
            {glyph}
            {name}
          </span>
          <span className="bars" ref={barsRef} aria-hidden="true">
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span className="ln" id="roots-say" data-testid="roots-say">
            <span className="say">{words}</span>
            <span className="held">heard</span>
            <span className="opening">opening main…</span>
          </span>
        </span>
      </Link>
      {showStop && (
        <button
          type="button"
          className="oz-roots-stop"
          data-testid="roots-stop"
          aria-label={snap.free ? 'leave hands-free' : 'stop'}
          onClick={() => lineRef.current?.stop()}
        >
          <StopSquare />
        </button>
      )}
      <span className="sr-only" role="status" aria-live="polite" data-testid="roots-status">
        {voiceOn || drop || note ? spoken : ''}
      </span>
    </div>
  );
}

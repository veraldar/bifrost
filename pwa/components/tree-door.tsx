'use client';

/** Tree-first (lib/tree-first.ts): the tree is the first thing a device ever
 *  sees, and afterwards the way back to THE MAIN session.
 *    Door      first open — the whole tree, server-rendered (it paints before
 *              any script runs). Press = amber at once; release = the door
 *              opens and speaks (pre-recorded, lib/onboard-voice.ts):
 *              language · style · the brain this box runs (shown, not asked)
 *              · on a desktop, the QR for the phone → MAIN, planted.
 *              Same steps, words and voice as veraldar.org's door; answers
 *              the site sent along (#door=v1.<lang>.<style>) skip their steps.
 *    TreeDoor  afterwards — the same drawing shrunk to its corner, a link
 *              to MAIN; the shrink from full screen plays once */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { YggTree } from '@/components/ygg';
import { diagEvent } from '@/lib/diag';
import { type SayResult, say, stopLine, warmLines } from '@/lib/onboard-voice';
import {
  type BoxInfo,
  DOOR_KEY,
  DOOR_VERSION,
  type DoorPrefs,
  FIRST_TURN_KEY,
  type Lang,
  MAIN_SLUG,
  type Style,
  TF_DONE_KEY,
  TF_PREFS_KEY,
  TF_SHRINK_KEY,
  doorHash,
  line,
  parseDoorHash,
} from '@/lib/tree-first';

type Step = 'idle' | 'lang' | 'style' | 'brain' | 'down';

const UI = {
  en: {
    hold: 'hold the tree to begin',
    heard: 'heard',
    short: 'short',
    shortSub: 'signal only',
    detail: 'more detail',
    detailSub: 'full sentences',
    brain: 'brain',
    cont: 'continue',
    here: 'continue here',
    retry: 'hold the tree to try again',
    opening: 'opening main…',
  },
  fr: {
    hold: "maintenez l'arbre pour commencer",
    heard: 'entendu',
    short: 'court',
    shortSub: 'juste le signal',
    detail: 'plus de détail',
    detailSub: 'des phrases complètes',
    brain: 'cerveau',
    cont: 'continuer',
    here: 'continuer ici',
    retry: "maintenez l'arbre pour réessayer",
    opening: 'ouverture de main…',
  },
} as const;

const STEPS: Step[] = ['lang', 'style', 'brain'];

export function Door() {
  const router = useRouter();
  const treeRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<Step>('idle');
  const [lang, setLang] = useState<Lang>('en');
  const [style, setStyle] = useState<Style | null>(null);
  const [carried, setCarried] = useState(false); // answers came from veraldar.org
  const [say1, setSay1] = useState(''); // the spoken line, always on screen too
  const [box, setBox] = useState<BoxInfo | null>(null);
  const [boxErr, setBoxErr] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [qr, setQr] = useState('');
  const [qrHost, setQrHost] = useState('');
  const [leaving, setLeaving] = useState(false);
  const mainRef = useRef<Promise<{ id: string }> | null>(null);
  const pressAt = useRef(0);
  const t0 = useRef(0);
  const langRef = useRef<Lang>('en');
  langRef.current = lang;

  // first paint → everything the first seconds need: the greeting (in
  // memory before the finger lands), what the box runs, MAIN's code
  useEffect(() => {
    const carry = parseDoorHash(window.location.hash);
    const l: Lang = carry?.lang || (/^fr/i.test(navigator.language) ? 'fr' : 'en');
    setLang(l);
    if (carry?.lang) {
      setCarried(true);
      if (carry.style) setStyle(carry.style);
    }
    warmLines([carry?.lang ? 'greet_back' : 'greet', 'lang'], l);
    setDesktop(window.matchMedia('(pointer: fine)').matches && navigator.maxTouchPoints === 0);
    router.prefetch(`/session/${MAIN_SLUG}`);
    void loadBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadBox(): Promise<BoxInfo | null> {
    try {
      const r = await fetch('/api/onboard', { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) throw new Error(`box ${r.status}`);
      const b = (await r.json()) as BoxInfo;
      setBox(b);
      setBoxErr(false);
      return b;
    } catch (e) {
      diagEvent('door', `box info failed: ${e instanceof Error ? e.message : e}`);
      setBoxErr(true);
      return null;
    }
  }

  /** speak a chain of lines; a newer chain (a tap) cuts this one */
  const chain = useRef(0);
  async function speak(ids: string[], l = langRef.current): Promise<void> {
    const my = ++chain.current;
    for (const id of ids) {
      if (chain.current !== my) return;
      setSay1(line(id, l));
      const r: SayResult = await say(id, l);
      if (r === 'stopped') return;
    }
  }

  /** MAIN + the standing preferences, sent as soon as both answers exist —
   *  the brain's one-line ack is done before the first voice turn */
  function seedMain(p: DoorPrefs) {
    mainRef.current = fetch('/api/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'main', prefs: p }),
      signal: AbortSignal.timeout(15_000),
    }).then(async (r) => {
      const d = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!r.ok || !d.id) throw new Error(d.error || `main ${r.status}`);
      return { id: d.id };
    });
    mainRef.current.catch(() => {});
  }

  // ── the tree: press = heard (amber, this frame), release = the door opens
  function press(e?: React.PointerEvent) {
    if (step !== 'idle' && step !== 'down') return;
    e?.currentTarget.setPointerCapture?.(e.pointerId);
    treeRef.current?.classList.add('heard'); // no React round-trip: amber now
    pressAt.current = performance.now();
  }
  function release() {
    const el = treeRef.current;
    if (!el?.classList.contains('heard')) return;
    el.classList.remove('heard');
    t0.current = performance.now();
    diagEvent('door', `open (held ${Math.round(t0.current - pressAt.current)}ms)`);
    // inside the gesture: the first line may play (and unlocks the rest)
    if (step === 'down' && style) {
      // the box did not answer at the brain step — the answers stand
      setStep('brain');
      seedMain({ lang, style });
      void openBrain([], style);
    } else if (carried && style) {
      setStep('brain');
      seedMain({ lang, style });
      void openBrain(['greet_back'], style);
    } else if (carried) {
      setStep('style');
      void speak(['greet_back', 'style']);
    } else {
      setStep('lang');
      void speak(['greet', 'lang']);
    }
    warmLines(['lang_set', 'style', 'style_short', 'style_detail'], lang);
  }

  function pickLang(l: Lang) {
    setLang(l);
    langRef.current = l;
    diagEvent('door', `lang=${l}`);
    try {
      document.documentElement.lang = l;
    } catch {
      /* cosmetic */
    }
    warmLines(['lang_set', 'style', 'style_short', 'style_detail', 'planted'], l);
    setStep('style');
    void speak(['lang_set', 'style'], l);
  }

  function pickStyle(s: Style) {
    setStyle(s);
    diagEvent('door', `style=${s}`);
    seedMain({ lang, style: s });
    setStep('brain');
    void openBrain([s === 'detail' ? 'style_detail' : 'style_short'], s);
  }

  /** `first` = what is said before the brain line (the style confirmation) */
  async function openBrain(first: string[], s: Style) {
    const b = box ?? (await loadBox());
    if (!b) {
      setStep('down');
      void speak([...first, 'box_down']);
      return;
    }
    const brainLine = `brain_${b.brain.class}`;
    warmLines([brainLine, 'pair', 'planted'], langRef.current);
    if (desktop) void makeQr(b, s);
    void speak([...first, brainLine, ...(desktop ? ['pair'] : [])]);
  }

  /** desktop: the phone scans its way in — the box's tailnet address, with
   *  the answers in the fragment, so the phone's door skips straight on */
  async function makeQr(b: BoxInfo, s: Style) {
    try {
      const base = (b.publicUrl || window.location.origin).replace(/\/$/, '');
      const url = `${base}/${doorHash({ lang: langRef.current, style: s })}`;
      const QR = await import('qrcode');
      setQr(await QR.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M' }));
      setQrHost(new URL(base).host);
    } catch {
      setQr('');
    }
  }

  /** the last tap: planted is said in this gesture while MAIN opens under it */
  async function enter() {
    if (leaving) return;
    setLeaving(true);
    stopLine();
    chain.current++;
    void say('planted', lang);
    setSay1(line('planted', lang));
    try {
      if (!mainRef.current) seedMain({ lang, style: style || 'short' });
      const { id } = await mainRef.current!;
      const prefs: DoorPrefs = { lang, style: style || 'short' };
      try {
        localStorage.setItem(TF_PREFS_KEY, JSON.stringify(prefs));
        localStorage.setItem(DOOR_KEY, DOOR_VERSION);
        localStorage.removeItem(TF_DONE_KEY); // v1's flag retires with v2
        localStorage.removeItem(FIRST_TURN_KEY); // MAIN opens with the first-turn card
        // the first turn is hold-to-talk: a v1 setup abandoned mid-way left
        // hands-free armed (oz-mode=free) — MAIN would open without the mic
        localStorage.setItem('oz-mode', 'text');
        localStorage.removeItem('tree-first-prev-mode');
        sessionStorage.setItem(TF_SHRINK_KEY, '1');
      } catch {
        /* private mode — MAIN still opens */
      }
      diagEvent('door', `→ MAIN after ${Math.round(performance.now() - t0.current)}ms`);
      router.push(`/session/${MAIN_SLUG}?id=${id}&first=1`);
    } catch (e) {
      diagEvent('door', `MAIN failed: ${e instanceof Error ? e.message : e}`);
      setLeaving(false);
      setStep('down');
      void speak(['box_down']);
    }
  }

  const n = STEPS.indexOf(step);
  const ui = UI[lang];
  const open = step !== 'idle';

  return (
    <main className={`oz-first ${open ? 'open' : ''}`} data-testid="door" data-step={step}>
      <button
        ref={treeRef}
        type="button"
        data-testid="tree-first"
        aria-label={open ? ui.hold : `${ui.hold} — bifrost speaks; sound on`}
        className="oz-ygg oz-tree"
        onPointerDown={press}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            press();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') release();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <YggTree slice />
      </button>

      {!open && (
        <p className="oz-invite" aria-hidden="true">
          <span className="hold">{ui.hold}</span>
          <span className="held">{ui.heard}</span>
        </p>
      )}

      {open && (
        <section className="oz-doorp" aria-live="polite">
          <div className="prog" aria-hidden="true">
            {STEPS.map((s, i) => (
              <i key={s} className={i <= n || step === 'down' ? 'on' : ''} />
            ))}
          </div>
          <p className="say" data-testid="door-say">
            {say1 || line(carried ? 'greet_back' : 'greet', lang)}
          </p>

          {step === 'lang' && (
            <div className="opts">
              {(['en', 'fr'] as Lang[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  className="opt"
                  data-testid={`door-lang-${l}`}
                  aria-pressed={lang === l}
                  onClick={() => pickLang(l)}
                >
                  {l === 'en' ? 'english' : 'français'}
                </button>
              ))}
            </div>
          )}

          {step === 'style' && (
            <div className="opts">
              {(['short', 'detail'] as Style[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className="opt"
                  data-testid={`door-style-${s}`}
                  aria-pressed={style === s}
                  onClick={() => pickStyle(s)}
                >
                  {s === 'short' ? ui.short : ui.detail}
                  <small>{s === 'short' ? ui.shortSub : ui.detailSub}</small>
                </button>
              ))}
            </div>
          )}

          {step === 'brain' && (
            <>
              <dl className="kv" data-testid="door-brain">
                <dt>{ui.brain}</dt>
                <dd>
                  {box ? (
                    <>
                      <b>{box.brain.model}</b> · {box.brain.where}
                    </>
                  ) : (
                    '…'
                  )}
                </dd>
                <dt>{lang === 'fr' ? 'réponses' : 'replies'}</dt>
                <dd>{style === 'detail' ? ui.detail : ui.short}</dd>
              </dl>
              {desktop && qr && (
                <figure className="pair" data-testid="door-qr">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt="QR — open bifrost on your phone, answers included" />
                  <figcaption>{qrHost}</figcaption>
                </figure>
              )}
              <button
                type="button"
                className="next"
                data-testid="door-enter"
                disabled={leaving || !box}
                onClick={() => void enter()}
              >
                {leaving ? ui.opening : desktop && qr ? ui.here : ui.cont}
              </button>
            </>
          )}

          {step === 'down' && (
            <p className="err" data-testid="door-down">
              {line('box_down', lang)}
              <span className="sub">{ui.retry}</span>
            </p>
          )}
          {boxErr && step !== 'down' && step !== 'brain' && <p className="sub">{line('box_down', lang)}</p>}
        </section>
      )}
    </main>
  );
}

export function TreeDoor() {
  const ref = useRef<HTMLAnchorElement>(null);
  // the one-shot is consumed before paint: the door starts at full screen
  // and settles into its corner — or simply stands there, every later time
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let play = false;
    try {
      play = sessionStorage.getItem(TF_SHRINK_KEY) !== null;
      sessionStorage.removeItem(TF_SHRINK_KEY);
    } catch {
      /* private mode — the door just stands */
    }
    if (!play) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // same crop both ends (slice, centered): scaled to cover the viewport,
    // the square door frames exactly what the full-screen tree showed
    el.style.setProperty('--tf-s', String(Math.max(vw, vh) / r.width));
    el.style.setProperty('--tf-x', `${vw / 2 - (r.left + r.width / 2)}px`);
    el.style.setProperty('--tf-y', `${vh / 2 - (r.top + r.height / 2)}px`);
    el.classList.add('shrink');
  }, []);

  return (
    <Link
      ref={ref}
      href={`/session/${MAIN_SLUG}`}
      data-testid="tree-door"
      aria-label="open MAIN"
      className="oz-door oz-ygg"
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.remove('shrink');
      }}
    >
      <YggTree slice />
    </Link>
  );
}

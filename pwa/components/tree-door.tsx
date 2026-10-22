'use client';

/** Tree-first (lib/tree-first.ts): the tree is the first thing a device ever
 *  sees, and afterwards the way back to THE MAIN session.
 *    Door      first open — the whole tree, server-rendered (it paints before
 *              any script runs). Press = amber at once; release = the door
 *              opens and speaks (pre-recorded, lib/onboard-voice.ts):
 *              language · style · the brain this computer runs (shown, not
 *              asked) · on a desktop, the QR for the phone → MAIN, planted.
 *              Same steps, words and voice as veraldar.org's door; answers
 *              the site sent along (#door=v1.<lang>.<style>) skip their steps.
 *              v3 (10-22): every step is a history entry (#…&at=<step>) — the
 *              phone's back button walks the steps, then back to the page
 *              that sent you; each name is glossed where it first appears,
 *              "why these names?" opens the $ tree + the tree film (lazy).
 *              No dead air (FILM-V1, 10-22): from the instant a step asks for
 *              its line until the line's first audio, the door says the voice
 *              is on its way — the panel's edge is the signal rail (a signal
 *              glides it: working), a pulse climbs the trunk, and past 0.7 s
 *              the words say so. Speaking: the rail breathes green. No sound
 *              at all: said in words, never a silent wait.
 *    TreeDoor  afterwards — the same drawing shrunk to its corner, a link
 *              to MAIN; the shrink from full screen plays once */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { YggTree } from '@/components/ygg';
import { diagEvent } from '@/lib/diag';
import {
  type SayResult,
  type VoiceState,
  lineBlob,
  say,
  stopLine,
  useVoiceState,
  warmLines,
} from '@/lib/onboard-voice';
import {
  type BoxInfo,
  DOOR_KEY,
  DOOR_VERSION,
  type DoorPrefs,
  type DoorStep,
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
  parseDoorStep,
} from '@/lib/tree-first';

type Step = 'idle' | DoorStep | 'down';

/** the tree film: a self-contained page served like any artifact, built in
 *  (pwa/artifacts-builtin) — loaded only when asked for, never on the way in */
export const FILM_SRC = '/api/artifact/door-tree.html';
const NAMES = ['name_tree', 'name_root', 'name_trunk', 'name_branch'];
const FILM_LINES = [...NAMES, 'name_try', 'name_done'];

const UI = {
  en: {
    hold: 'hold the tree to begin',
    holdSub: 'the tree stands for your own computer · sound on',
    heard: 'heard',
    short: 'short',
    shortSub: 'just the point',
    detail: 'more detail',
    detailSub: 'full sentences',
    glossBifrost: 'bifrost — the bridge between you and your computer',
    glossRoot: 'the root — your tree’s brain: it thinks and remembers',
    brain: 'brain',
    at: 'at',
    replies: 'replies',
    cont: 'continue',
    here: 'continue here',
    retry: 'hold the tree to try again',
    opening: 'opening main…',
    why: 'why these names?',
    hear: 'hear it',
    watch: 'watch it · 15 s',
    skip: 'skip ✕',
    tree: [
      ['$ tree yggdrasil', ''],
      ['yggdrasil', 'the tree: your computer, all of it'],
      ['├─ root', 'the brain: thinks, remembers'],
      ['├─ trunk', 'the private line: carries your words'],
      ['└─ branch', 'bifrost, this app: the bridge to you'],
    ],
    treeNote: 'old norse names. each one says what the part does.',
    voiceLoading: 'the voice is on its way…',
    voiceQuiet: 'no sound here — the words are on screen',
    filmLoading: 'the film is on its way…',
  },
  fr: {
    hold: "maintenez l'arbre pour commencer",
    holdSub: "l'arbre, c'est votre propre ordinateur · son activé",
    heard: 'entendu',
    short: 'court',
    shortSub: "juste l'essentiel",
    detail: 'plus de détail',
    detailSub: 'des phrases complètes',
    glossBifrost: 'bifrost — le pont entre vous et votre ordinateur',
    glossRoot: 'la racine — le cerveau de votre arbre : elle réfléchit et se souvient',
    brain: 'cerveau',
    at: 'chez',
    replies: 'réponses',
    cont: 'continuer',
    here: 'continuer ici',
    retry: "maintenez l'arbre pour réessayer",
    opening: 'ouverture de main…',
    why: 'pourquoi ces noms ?',
    hear: 'écouter',
    watch: 'voir · 15 s',
    skip: 'passer ✕',
    tree: [
      ['$ tree yggdrasil', ''],
      ['yggdrasil', "l'arbre : votre ordinateur, en entier"],
      ['├─ racine', 'le cerveau : réfléchit, se souvient'],
      ['├─ tronc', 'la ligne privée : porte vos mots'],
      ['└─ branche', 'bifrost, cette appli : le pont vers vous'],
    ],
    treeNote: 'des noms nordiques anciens. chacun dit ce que fait la pièce.',
    voiceLoading: 'la voix arrive…',
    voiceQuiet: 'pas de son ici — les mots sont à l’écran',
    filmLoading: 'le film arrive…',
  },
} as const;

const STEPS: DoorStep[] = ['lang', 'style', 'brain'];
const hasFilm = (hash: string) => /(?:^#|&)film\b/.test(hash);
const brainLineOf = (b: BoxInfo) => (b.brain.class === 'local' ? 'brain_local' : 'brain_cloud');
/** the voice's state → the app's rail vocabulary (styles/brand.css § rail) */
const RAIL: Record<VoiceState, string> = { idle: 'idle', loading: 'working', speaking: 'speaking', quiet: 'idle' };

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
  const [names, setNames] = useState(false); // "why these names?" open
  const [film, setFilm] = useState(false);
  const [filmUp, setFilmUp] = useState(false); // the film's own page has painted
  const [boxWait, setBoxWait] = useState(false); // the brain's line waits on the computer
  const voice = useVoiceState();
  // waiting on the computer before the line can even be asked for is
  // loading too: the next words are on their way, the screen says so
  const shown: VoiceState = voice === 'idle' && boxWait ? 'loading' : voice;
  const filmRef = useRef<HTMLIFrameElement>(null);
  const mainRef = useRef<Promise<{ id: string }> | null>(null);
  const pressAt = useRef(0);
  const t0 = useRef(0);
  const langRef = useRef<Lang>('en');
  langRef.current = lang;
  // the popstate handler is bound once: it reads the live values from here
  const live = useRef({ step, style, box, desktop });
  live.current = { step, style, box, desktop };

  // first paint → everything the first seconds need: the greeting (in
  // memory before the finger lands), what the computer runs, MAIN's code
  useEffect(() => {
    const h = window.location.hash;
    const carry = parseDoorHash(h);
    const l: Lang = carry?.lang || (/^fr/i.test(navigator.language) ? 'fr' : 'en');
    setLang(l);
    if (carry?.lang) {
      setCarried(true);
      if (carry.style) setStyle(carry.style);
    }
    // a reload mid-door: this entry IS the tree again (the answers stay)
    if (parseDoorStep(h) || hasFilm(h)) {
      const keep = doorHash(carry || {});
      const url = window.location.pathname + window.location.search;
      history.replaceState({ door: 'idle' }, '', keep === '#' ? url : url + keep);
    }
    warmLines([carry?.lang ? 'greet_back' : 'greet', 'lang'], l);
    setDesktop(window.matchMedia('(pointer: fine)').matches && navigator.maxTouchPoints === 0);
    router.prefetch(`/session/${MAIN_SLUG}`);
    void loadBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── history: back/forward lands on a door step, or on the page before it
  useEffect(() => {
    function onPop() {
      const h = window.location.hash;
      const at = parseDoorStep(h);
      const carry = parseDoorHash(h);
      setFilm(hasFilm(h));
      const cur = live.current.step;
      if ((at ?? 'idle') === cur || (cur === 'down' && at === 'brain')) return; // the film closed
      stopLine();
      chain.current++;
      setNames(false);
      if (carry?.lang) {
        setLang(carry.lang);
        langRef.current = carry.lang;
      }
      const s = carry?.style ?? live.current.style;
      if (carry?.style) setStyle(carry.style);
      diagEvent('door', `history → ${at ?? 'tree'}`);
      if (!at) {
        setStep('idle');
      } else if (at === 'brain' && s) {
        setStep('brain');
        if (!mainRef.current) seedMain({ lang: langRef.current, style: s });
        void openBrain([], s);
      } else {
        const back = at === 'brain' ? 'style' : at;
        setStep(back);
        void speak([back]);
      }
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** a new step = a new history entry, its answers in the fragment */
  function go(next: DoorStep, p: Partial<DoorPrefs>) {
    setStep(next);
    setNames(false);
    try {
      // a fresh state object: Next copies its own router state into it
      history.pushState({ door: next }, '', doorHash(p, next));
    } catch {
      /* the door works without history */
    }
  }

  async function loadBox(): Promise<BoxInfo | null> {
    try {
      const r = await fetch('/api/onboard', { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) throw new Error(`box ${r.status}`);
      const b = (await r.json()) as BoxInfo;
      setBox(b);
      setBoxErr(false);
      warmLines([brainLineOf(b)], langRef.current); // in memory before the brain step
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
      // the computer did not answer at the brain step — the answers stand
      setStep('brain');
      seedMain({ lang, style });
      void openBrain([], style);
    } else if (carried && style) {
      go('brain', { lang, style });
      seedMain({ lang, style });
      void openBrain(['greet_back'], style);
    } else if (carried) {
      go('style', { lang });
      void speak(['greet_back', 'style']);
    } else {
      go('lang', {});
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
    const b = live.current.box;
    warmLines(['lang_set', 'style', 'style_short', 'style_detail', 'planted', ...(b ? [brainLineOf(b)] : [])], l);
    go('style', { lang: l });
    void speak(['lang_set', 'style'], l);
  }

  function pickStyle(s: Style) {
    setStyle(s);
    diagEvent('door', `style=${s}`);
    seedMain({ lang, style: s });
    go('brain', { lang, style: s });
    void openBrain([s === 'detail' ? 'style_detail' : 'style_short'], s);
  }

  /** `first` = what is said before the brain line (the style confirmation) */
  async function openBrain(first: string[], s: Style) {
    let b = live.current.box;
    if (!b) {
      // the confirmation needs no computer: it speaks while the computer
      // answers; until the brain's line can be asked for, it is on its way
      setBoxWait(true);
      const said = speak(first);
      const my = chain.current;
      [b] = await Promise.all([loadBox(), said]);
      setBoxWait(false);
      if (chain.current !== my) return;
      first = [];
    }
    if (!b) {
      setStep('down');
      void speak([...first, 'box_down']);
      return;
    }
    const brainLine = brainLineOf(b);
    warmLines([brainLine, 'pair', 'planted'], langRef.current);
    const desk = live.current.desktop;
    if (desk) void makeQr(b, s);
    void speak([...first, brainLine, ...(desk ? ['pair'] : [])]);
  }

  /** desktop: the phone scans its way in — the computer's tailnet address,
   *  with the answers in the fragment, so the phone's door skips straight on */
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

  /** "why these names?": the $ tree on screen, its spoken version on demand */
  function toggleNames() {
    const open = !names;
    setNames(open);
    diagEvent('door', `names ${open ? 'open' : 'closed'}`);
    if (open) warmLines(FILM_LINES, langRef.current); // the film's too: it plays from this memory
    else {
      stopLine();
      chain.current++;
    }
  }

  /** the film: one more history entry (back closes it); the door goes quiet */
  function openFilm() {
    stopLine();
    chain.current++;
    diagEvent('door', 'film open');
    setFilmUp(false);
    setFilm(true);
    try {
      history.pushState({ door: 'film' }, '', `${window.location.hash || '#'}&film`);
    } catch {
      /* no history: the skip button still closes it */
    }
  }
  function closeFilm() {
    if (hasFilm(window.location.hash))
      history.back(); // popstate closes it
    else setFilm(false);
  }
  // the film says when it is done (its last button) — the door takes over again
  useEffect(() => {
    if (!film) return;
    const onMsg = (e: MessageEvent) => {
      const win = filmRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const d = e.data as { tree?: string; voice?: string; lang?: string; ids?: unknown };
      // the film asks for its lines: handed over from this page's memory
      // (only the pack's own line ids — never an address)
      if (d?.voice === 'need' && Array.isArray(d.ids)) {
        const l: Lang = d.lang === 'fr' ? 'fr' : 'en';
        const ids = d.ids.filter((x): x is string => typeof x === 'string' && /^[a-z_]{1,32}$/.test(x)).slice(0, 64);
        win.postMessage({ voice: 'ack', lang: l }, '*'); // at once: the film waits for these, fetches nothing
        for (const id of ids)
          void lineBlob(id, l).then((blob) => win.postMessage({ voice: 'line', id, lang: l, blob }, '*'));
        return;
      }
      const tree = d?.tree;
      if (tree === 'up') setFilmUp(true); // its first frame: it shows its own loading from here
      if (tree === 'done') {
        diagEvent('door', 'film done');
        closeFilm();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [film]);

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

  const n = step === 'idle' || step === 'down' ? -1 : STEPS.indexOf(step);
  const ui = UI[lang];
  const open = step !== 'idle';

  return (
    <main
      className={`oz-first ${open ? 'open' : ''}`}
      data-testid="door"
      data-step={step}
      data-voice={open ? shown : 'idle'}
    >
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
          <span className="sub">{ui.holdSub}</span>
        </p>
      )}

      {open && (
        <section className="oz-doorp" aria-live="polite">
          {/* the panel's edge is the voice's signal rail */}
          <div
            className="oz-rail vrail"
            data-testid="door-voice"
            data-voice={shown}
            data-s={RAIL[shown]}
            aria-hidden="true"
          />
          <div className="prog">
            {STEPS.map((s, i) => (
              <i key={s} aria-hidden="true" className={i <= n || step === 'down' ? 'on' : ''} />
            ))}
            <span className="vnote" data-voice={shown} data-testid="door-voice-note" role="status">
              {shown === 'loading' ? ui.voiceLoading : shown === 'quiet' ? ui.voiceQuiet : ''}
            </span>
          </div>
          <p className="say" data-testid="door-say">
            {say1 || line(carried ? 'greet_back' : 'greet', lang)}
          </p>
          {(step === 'lang' || step === 'style') && (
            <p className="gloss" data-testid="door-gloss">
              {ui.glossBifrost}
            </p>
          )}

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
              <p className="gloss" data-testid="door-gloss">
                {ui.glossRoot}
              </p>
              <dl className="kv" data-testid="door-brain">
                <dt>{ui.brain}</dt>
                <dd>
                  {box ? (
                    <>
                      <b>{box.brain.model}</b>
                      {box.brain.provider && (
                        <>
                          {' '}
                          · {box.brain.class === 'local' ? '' : `${ui.at} `}
                          {box.brain.provider}
                        </>
                      )}
                      <small>{box.brain.where}</small>
                    </>
                  ) : (
                    '…'
                  )}
                </dd>
                <dt>{ui.replies}</dt>
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
          {boxErr && step !== 'down' && step !== 'brain' && (
            <p className="sub">{line('box_down', lang)}</p>
          )}

          {step !== 'down' && (
            <div className="names" data-testid="door-names" data-open={names ? '' : undefined}>
              <button type="button" className="why" aria-expanded={names} onClick={toggleNames}>
                {ui.why}
              </button>
              {names && (
                <>
                  <div
                    className="tree"
                    role="img"
                    aria-label={NAMES.map((id) => line(id, lang)).join(' ')}
                  >
                    {ui.tree.map(([k, v]) => (
                      <div key={k} className={v ? '' : 'cmd'}>
                        <span>{k}</span>
                        {v && <i>{v}</i>}
                      </div>
                    ))}
                  </div>
                  <p className="sub">{ui.treeNote}</p>
                  <div className="row">
                    <button
                      type="button"
                      data-testid="door-names-hear"
                      onClick={() => void speak(NAMES)}
                    >
                      ▸ {ui.hear}
                    </button>
                    <button type="button" data-testid="door-film" onClick={openFilm}>
                      ▸ {ui.watch}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {film && (
        <div
          className="oz-film"
          data-testid="door-film-frame"
          data-up={filmUp ? '' : undefined}
          role="dialog"
          aria-label={ui.watch}
        >
          {/* under the frame until the film's own first paint covers it */}
          <p className="wait" data-testid="door-film-wait" role="status">
            <span className="oz-rail" data-s="working" aria-hidden="true" />
            {ui.filmLoading}
          </p>
          <iframe
            title={ui.watch}
            src={`${FILM_SRC}?lang=${lang}`}
            sandbox="allow-scripts"
            allow="autoplay"
            ref={filmRef}
            onLoad={() => setFilmUp(true)}
          />
          <button type="button" className="skip" data-testid="door-film-skip" onClick={closeFilm}>
            {ui.skip}
          </button>
        </div>
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

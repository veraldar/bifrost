/** Streaming TTS deck: ONE continuous generation per message on the Mac
 *  (raw PCM stream) — the voice is physically constant, no chunk boundaries.
 *
 *  Playback through native <audio> elements (phones suspend WebAudio in the
 *  background; the media pipeline keeps playing). Received PCM is wrapped
 *  into ~6s WAV blobs played as a DOUBLE-BUFFERED playlist: while piece N
 *  plays, piece N+1 is preloaded on the second element — the swap at the
 *  boundary is instant instead of leaving an audible gap. All pieces are
 *  kept so seek works forwards AND backwards. */

export type SpeechPhase = 'idle' | 'loading' | 'playing' | 'paused';
export type SpeechState = {
  phase: SpeechPhase;
  /** played position, 0..1 of the estimated total */
  progress: number;
  /** played position, seconds */
  positionSec: number;
  /** received (synthesized) audio, seconds */
  receivedSec: number;
  /** rough total estimate, seconds (text-length based) */
  totalEstSec: number;
  rate: number;
};

const SAMPLE_RATE = 24000;
const PIECE_SEC = 10; // wav blob length for the playlist
const SEC_PER_CHAR = 0.075;

function initialRate(): number {
  // spoken replies default to the last rate the user chose (survives reloads)
  try {
    const r = Number(localStorage.getItem('oz-tts-rate'));
    return r > 0 ? r : 1;
  } catch {
    return 1;
  }
}

let state: SpeechState = {
  phase: 'idle',
  progress: 0,
  positionSec: 0,
  receivedSec: 0,
  totalEstSec: 0,
  rate: initialRate(),
};
const subs = new Set<() => void>();
import { diagEvent } from '@/lib/diag';
function set(patch: Partial<SpeechState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export function subscribeSpeech(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}
export function getSpeech(): SpeechState {
  return state;
}

let els: [HTMLAudioElement, HTMLAudioElement] | null = null;
let activeEl = 0; // which element is (or will be) playing the current piece
let abort: AbortController | null = null;
// first-audio watchdog: the Mac accepting the stream but never delivering
// audio left the deck in 'synthesizing…' forever (live 09-30 session test-hf:
// POST 200 in 443ms, zero bytes, no first-audio log) — and hands-free held
// the mic hostage until the user fled the page
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let gen = 0;
let msgLang: 'fr' | 'en' = 'fr';
let curSlug = '';

type Piece = { url: string; startSample: number; samples: number };
let pieces: Piece[] = []; // every piece, in order — kept for seeks
let curIdx = -1; // piece loaded in the active element
let userPaused = false;
let pendingFloat: Float32Array | null = null; // received PCM not yet wrapped
let pendingLen = 0;
let totalReceived = 0;
let streamDone = false;
let pendingSkip: number | null = null; // seek target beyond received audio
let tickTimer: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;

function setPhase(p: SpeechPhase) {
  if (state.phase !== p) set({ phase: p });
}

function detectLang(s: string): 'fr' | 'en' {
  if (/[àâçéèêëîïôùûüœ]/i.test(s)) return 'fr';
  const fr = (
    s.toLowerCase().match(
      /\b(le|la|les|un|une|des|du|et|est|que|qui|pour|avec|dans|pas|vous|je|sur|au|aux|ce|cette|mais|plus|tout|tous|par|comme|il|elle|on|nous|son|sa|ses|ne|se|en|y|déjà|très|alors|donc|corriger|corrigé|déployer|déployé|deploye|tester|testé|changer|changé|voix|faut|était|peux|veux|vais|voilà|merci|parce|pendant|depuis|encore|aussi|besoin)\b/gi
    ) || []
  ).length;
  const en = (
    s.toLowerCase().match(
      /\b(the|and|is|are|you|for|with|this|that|have|not|was|from|but|they|will|can|what|when|how|should|would|there|then|again)\b/gi
    ) || []
  ).length;
  return fr >= 1 && fr >= en ? 'fr' : 'en';
}

function ensureEls(): [HTMLAudioElement, HTMLAudioElement] {
  if (!els) {
    const make = (): HTMLAudioElement => {
      const a = new Audio();
      a.preload = 'auto';
      (a as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      a.addEventListener('ended', () => onPieceEnded(a));
      return a;
    };
    els = [make(), make()];
  }
  return els;
}

function onPieceEnded(el: HTMLAudioElement): void {
  if (el !== els![activeEl]) return; // idle twin ended prematurely — ignore
  const nextIdx = curIdx + 1;
  if (nextIdx < pieces.length) {
    activeEl = 1 - activeEl;
    const el2 = els![activeEl];
    el2.playbackRate = state.rate;
    if (!userPaused) {
      void el2.play().catch((e) => console.warn('tts swap play failed:', String(e)));
    }
    curIdx = nextIdx;
    tick();
    // refill the idle twin with the piece after the next — UNCONDITIONALLY:
    // the twin still holds its previous piece's src, and playing it again is
    // what made audio restart from the beginning at the 20s boundary
    if (pieces[curIdx + 1]) {
      els![1 - activeEl].src = pieces[curIdx + 1].url;
    }
  } else if (streamDone) {
    // user paused right at the natural end → keep the deck open, paused
    if (userPaused) setPhase('paused');
    else stopSpeech(); // natural end
  } else {
    diagEvent('tts', 'boundary stall: stream lagging behind playback');
    setPhase('loading'); // stream lagging — enqueue() resumes playback
  }
}

function tick(): void {
  if (state.phase === 'idle') return;
  if (curIdx >= 0 && pieces[curIdx] && els) {
    const el = els[activeEl];
    const posSec = (pieces[curIdx].startSample + el.currentTime * SAMPLE_RATE) / SAMPLE_RATE;
    set({
      positionSec: posSec,
      progress: Math.min(1, posSec / Math.max(state.totalEstSec, 0.5)),
    });
  }
}

function playPiece(idx: number, offsetSec = 0): void {
  const [e0, e1] = ensureEls();
  activeEl = 0;
  const piece = pieces[idx];
  curIdx = idx;
  e0.src = piece.url;
  e0.playbackRate = state.rate;
  e1.removeAttribute('src'); // clear the twin
  if (offsetSec > 0) {
    const onMeta = () => {
      try {
        e0.currentTime = offsetSec;
      } catch {
        /* not seekable yet */
      }
      e0.removeEventListener('loadedmetadata', onMeta);
    };
    e0.addEventListener('loadedmetadata', onMeta);
  }
  if (userPaused) {
    setPhase('paused');
    return;
  }
  void e0.play().then(() => {
    if (state.phase === 'loading') {
      setPhase('playing');
      if (startedAt) {
        console.warn(`tts: first audio in ${Date.now() - startedAt}ms`);
        startedAt = 0;
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      }
    }
    if (pieces[idx + 1]) e1.src = pieces[idx + 1].url; // preload next
  }).catch((e) => {
    console.warn('tts audio play failed:', String(e)); // diag
    setPhase('paused');
  });
}


function wavBlob(f32: Float32Array, len: number): Blob {
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  v.setUint32(4, 36 + len * 2, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, 'data');
  v.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(44 + i * 2, s * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function enqueuePiece(startSample: number, len: number): void {
  const url = URL.createObjectURL(wavBlob(pendingFloat!, len));
  pieces.push({ url, startSample, samples: len });
  const idx = pieces.length - 1;
  // start playback if the player is waiting for this piece — but prebuffer
  // TWO pieces (20s of audio) first: the stream synths 3× faster than
  // playback, so this only delays the start ~2s while absorbing network
  // hiccups that would otherwise break playback at an early boundary
  const initialReady = curIdx < 0 && (pieces.length >= 2 || streamDone);
  const stalledAtBoundary = curIdx >= 0 && idx === curIdx + 1 && state.phase === 'loading';
  const continuationWhileEnded =
    curIdx >= 0 && els !== null && els[activeEl].ended;
  if (initialReady || stalledAtBoundary || continuationWhileEnded) {
    // ALWAYS start the chain at the FIRST piece (the beginning of the text) —
    // starting at idx (the latest enqueued) made playback jump to ~12s on open
    const startIdx = curIdx < 0 ? 0 : idx;
    let offsetSec = 0;
    if (pendingSkip !== null && pendingSkip > pieces[startIdx].startSample) {
      offsetSec = (pendingSkip - pieces[startIdx].startSample) / SAMPLE_RATE;
      pendingSkip = null;
    }
    playPiece(startIdx, offsetSec);
  }
}

function maybeFinish(): void {
  if (streamDone && curIdx >= pieces.length - 1 && state.phase !== 'idle') {
    // only finish when the last piece ACTUALLY finished playing. A short
    // reply's stream completes while the first play() is still starting —
    // stopping here pauses an element mid-play-start and the play() promise
    // rejects with AbortError (the reply is murdered before a single sample).
    // The natural 'ended' event → onPieceEnded → stopSpeech() finishes it.
    const el = els?.[activeEl];
    if (!el || el.ended) stopSpeech();
  }
}

/** Position in absolute samples. */
function positionSamples(): number {
  if (curIdx >= 0 && pieces[curIdx] && els) {
    return pieces[curIdx].startSample + Math.round(els[activeEl].currentTime * SAMPLE_RATE);
  }
  return Math.round(state.positionSec * SAMPLE_RATE);
}

async function run(text: string, myGen: number): Promise<void> {
  // any stream failure must land in stopSpeech, never strand 'loading':
  // the route holds the connection up to 10 min, a mid-stream death
  // otherwise looked exactly like the eternal "synthesizing…" of 09-30
  try {
    const res = await fetch('/api/tts/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang: msgLang }),
      signal: abort!.signal,
    });
    if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const reader = res.body!.getReader();
    let carry = new Uint8Array(0);
    while (true) {
      const { done, value } = await reader.read();
      if (gen !== myGen) return;
      if (done) break;
      const all = new Uint8Array(carry.length + value.length);
      all.set(carry);
      all.set(value, carry.length);
      const usable = all.length - (all.length % 2);
      carry = all.slice(usable);
      const int16 = new Int16Array(all.buffer, 0, usable / 2);
      if (int16.length) appendPcm(int16, myGen);
    }
    streamDone = true;
    if (pendingLen > 0) {
      const start = totalReceived - pendingLen;
      enqueuePiece(start, pendingLen);
      pendingFloat = null;
      pendingLen = 0;
    }
    // if the last piece already ended while we were wrapping, finish now
    if (curIdx >= pieces.length - 1) maybeFinish();
  } catch (e) {
    if (gen !== myGen) return; // superseded by a newer start / deliberate stop
    console.warn(`tts stream failed: ${String(e)}`); // diag
    stopSpeech();
  }
}


function appendPcm(int16: Int16Array, myGen: number): void {
  if (!pendingFloat || pendingFloat.length < pendingLen + int16.length) {
    const cap = Math.max(
      pendingLen + int16.length,
      (pendingFloat?.length || 0) * 2,
      SAMPLE_RATE * PIECE_SEC
    );
    const nb = new Float32Array(cap);
    if (pendingFloat && pendingLen) nb.set(pendingFloat.subarray(0, pendingLen));
    pendingFloat = nb;
  }
  for (let i = 0; i < int16.length; i++) pendingFloat[pendingLen + i] = int16[i] / 32768;
  pendingLen += int16.length;
  totalReceived += int16.length;
  const receivedSec = totalReceived / SAMPLE_RATE;
  set({ receivedSec, totalEstSec: Math.max(state.totalEstSec, receivedSec) });

  // seek beyond received: hold on "synthesizing" until the stream arrives
  if (pendingSkip !== null && totalReceived < pendingSkip) {
    setPhase('loading');
    return;
  }
  if (pendingLen >= SAMPLE_RATE * PIECE_SEC) {
    const start = totalReceived - pendingLen;
    enqueuePiece(start, pendingLen);
    pendingFloat = null;
    pendingLen = 0;
  }
}

/** Start speaking `text` from the beginning (stops any current playback). */
export function startSpeech(text: string, slug = ''): void {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' (table) ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
  if (!clean) return;
  stopSpeech();
  curSlug = slug;
  msgLang = detectLang(clean.slice(0, 600)); // ONE language per message
  userPaused = false;
  ensureEls();
  abort = new AbortController();
  startedAt = Date.now();
  streamDone = false;
  pendingSkip = null;
  pieces = [];
  curIdx = -1;
  pendingFloat = null;
  pendingLen = 0;
  totalReceived = 0;
  const totalEstSec = Math.max(3, clean.length * SEC_PER_CHAR);
  set({ phase: 'loading', progress: 0, positionSec: 0, receivedSec: 0, totalEstSec });
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => tick(), 500); // drives position/progress UI
  const myGen = gen; // run() captured the same value
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    stallTimer = null;
    // startedAt is zeroed the moment audio actually plays — non-zero here
    // means nothing ever arrived (seek-back-into-loading has audio already)
    if (gen !== myGen || state.phase !== 'loading' || startedAt === 0) return;
    console.warn(`tts: no first audio after ${Date.now() - startedAt}ms — giving up`); // diag
    stopSpeech();
  }, 20_000);
  void run(clean, gen);
}

export function pauseSpeech(): void {
  if (state.phase !== 'playing') return;
  userPaused = true;
  els?.[activeEl].pause();
  setPhase('paused');
}

export function resumeSpeech(): void {
  if (state.phase !== 'paused') return;
  userPaused = false;
  if (els && curIdx >= 0) {
    void els[activeEl].play().catch((e) => console.warn('tts resume failed:', String(e)));
  } else {
    // nothing loaded (e.g. paused during initial synthesis) — enqueue will start
    if (pendingLen > 0) {
      const start = totalReceived - pendingLen;
      enqueuePiece(start, pendingLen);
      pendingFloat = null;
      pendingLen = 0;
    }
  }
  setPhase('playing');
}

/** Seek to `fraction` (0..1) of the estimated total. Within received audio:
 *  instant. Beyond: pauses on "synthesizing" until the stream arrives. */
export function seekSpeech(fraction: number): void {
  if (state.phase === 'idle') return;
  const frac = Math.min(0.999, Math.max(0, fraction));
  const totalSamples = Math.max(Math.round(state.totalEstSec * SAMPLE_RATE), totalReceived + 1);
  const target = Math.round(frac * totalSamples);
  const idx = pieces.findIndex(
    (p) => target >= p.startSample && target < p.startSample + p.samples
  );
  if (idx >= 0) {
    pendingSkip = null;
    const wasPaused = userPaused || state.phase === 'paused';
    playPiece(idx, (target - pieces[idx].startSample) / SAMPLE_RATE);
    if (wasPaused) {
      userPaused = true;
      els![activeEl].pause();
      setPhase('paused');
    }
    return;
  }
  // beyond received — wait for the stream
  pendingSkip = target;
  setPhase('loading');
}

export function rateSpeech(rate: number): void {
  set({ rate });
  try {
    localStorage.setItem('oz-tts-rate', String(rate));
  } catch {
    /* private mode */
  }
  if (els) {
    els[0].playbackRate = rate;
    els[1].playbackRate = rate;
  }
}

/** Kill everything. */
export function stopSpeech(): void {
  gen++;
  abort?.abort();
  abort = null;
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
  if (els) {
    for (const el of els) {
      el.pause();
      el.removeAttribute('src');
      el.load(); // force position reset — the element is reused across plays
    }
  }
  for (const p of pieces) URL.revokeObjectURL(p.url);
  pieces = [];
  curIdx = -1;
  activeEl = 0;
  pendingFloat = null;
  pendingLen = 0;
  totalReceived = 0;
  streamDone = false;
  pendingSkip = null;
  userPaused = false;
  startedAt = 0;
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (state.phase !== 'idle') {
    set({ phase: 'idle', progress: 0, positionSec: 0, receivedSec: 0 });
  }
}

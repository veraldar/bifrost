/** Streaming TTS deck: ONE continuous generation per message on the Mac
 *  (raw PCM stream) — the voice is physically constant, no chunk boundaries.
 *
 *  Playback through a native <audio> element (NOT WebAudio): phones suspend
 *  AudioContexts when the screen locks or the tab hides, while the media
 *  pipeline keeps playing in the background. Received PCM is wrapped into
 *  ~6s WAV blobs played as a playlist; all pieces are kept so seek works
 *  forwards AND backwards. */

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
const PIECE_SEC = 6; // wav blob length for the playlist
const SEC_PER_CHAR = 0.075;

let state: SpeechState = {
  phase: 'idle',
  progress: 0,
  positionSec: 0,
  receivedSec: 0,
  totalEstSec: 0,
  rate: 1,
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

let audio: HTMLAudioElement | null = null;
let abort: AbortController | null = null;
let gen = 0;
let msgLang: 'fr' | 'en' = 'fr';
let curSlug = '';

type Piece = { url: string; startSample: number; samples: number };
let pieces: Piece[] = []; // every piece, in order — kept for seeks
let curIdx = -1; // piece loaded in the audio element
let nextIdx = 0; // next piece to play
let pendingFloat: Float32Array | null = null; // received PCM not yet wrapped
let pendingLen = 0;
let totalReceived = 0;
let streamDone = false;
let pendingSkip: number | null = null; // seek target beyond received audio
let userPaused = false;
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

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
    (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audio.addEventListener('ended', () => playNext());
  }
  return audio;
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

function tick(): void {
  if (state.phase === 'idle') return;
  if (curIdx >= 0 && pieces[curIdx] && audio) {
    const posSec = (pieces[curIdx].startSample + audio.currentTime * SAMPLE_RATE) / SAMPLE_RATE;
    set({
      positionSec: posSec,
      progress: Math.min(1, posSec / Math.max(state.totalEstSec, 0.5)),
    });
  }
}

function playNext(): void {
  const a = ensureAudio();
  // seek target beyond the next piece(s): skip what a seek left behind
  while (pendingSkip !== null && nextIdx < pieces.length) {
    const p = pieces[nextIdx];
    if (pendingSkip < p.startSample + p.samples) break;
    nextIdx++;
  }
  if (nextIdx >= pieces.length) {
    if (streamDone) stopSpeech(); // natural end
    return; // waiting for more pieces — enqueue() will call playNext()
  }
  let piece = pieces[nextIdx];
  let offset = 0;
  if (pendingSkip !== null && pendingSkip > piece.startSample) {
    offset = (pendingSkip - piece.startSample) / SAMPLE_RATE;
    pendingSkip = null;
  }
  curIdx = nextIdx;
  nextIdx++;
  const a2 = a;
  a2.src = piece.url;
  a2.playbackRate = state.rate;
  if (offset > 0) {
    const onMeta = () => {
      try {
        a2.currentTime = offset;
      } catch {
        /* not seekable yet */
      }
      a2.removeEventListener('loadedmetadata', onMeta);
    };
    a2.addEventListener('loadedmetadata', onMeta);
  }
  if (userPaused) {
    setPhase('paused');
    return;
  }
  void a2.play().then(() => {
    if (state.phase === 'loading') {
      setPhase('playing');
      if (startedAt) {
        console.warn(`tts: first audio in ${Date.now() - startedAt}ms`);
        startedAt = 0;
      }
    }
  }).catch((e) => {
    console.warn('tts audio play failed:', String(e)); // diag
    setPhase('paused');
  });
}

function enqueuePiece(startSample: number, len: number): void {
  const url = URL.createObjectURL(wavBlob(pendingFloat!, len));
  pieces.push({ url, startSample, samples: len });
  // start/resume playback when this is the piece the player waits for
  if (nextIdx === pieces.length - 1 && (state.phase === 'loading' || audio?.ended || audio?.paused)) {
    if (!userPaused || state.phase === 'loading') playNext();
  }
}

function maybeFinish(): void {
  if (streamDone && nextIdx >= pieces.length && state.phase !== 'idle') {
    stopSpeech(); // natural end
  }
}

/** Position in absolute samples. */
function positionSamples(): number {
  if (curIdx >= 0 && pieces[curIdx] && audio) {
    return pieces[curIdx].startSample + Math.round(audio.currentTime * SAMPLE_RATE);
  }
  return Math.round(state.positionSec * SAMPLE_RATE);
}

async function run(text: string, myGen: number): Promise<void> {
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
  maybeFinish();
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
  msgLang = detectLang(clean.slice(0, 600));
  userPaused = false;
  ensureAudio();
  abort = new AbortController();
  startedAt = Date.now();
  streamDone = false;
  pendingSkip = null;
  pieces = [];
  curIdx = -1;
  nextIdx = 0;
  pendingFloat = null;
  pendingLen = 0;
  totalReceived = 0;
  const totalEstSec = Math.max(3, clean.length * SEC_PER_CHAR);
  set({ phase: 'loading', progress: 0, positionSec: 0, receivedSec: 0, totalEstSec });
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => tick(), 500); // drives position/progress UI
  void run(clean, gen);
}

export function pauseSpeech(): void {
  if (state.phase !== 'playing') return;
  userPaused = true;
  audio?.pause();
  setPhase('paused');
}

export function resumeSpeech(): void {
  if (state.phase !== 'paused') return;
  userPaused = false;
  if (audio && audio.src) {
    void audio.play().catch((e) => console.warn('tts resume failed:', String(e)));
  } else {
    playNext();
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
    curIdx = idx;
    nextIdx = idx + 1;
    const a = ensureAudio();
    a.src = pieces[idx].url;
    a.playbackRate = state.rate;
    const seek = () => {
      try {
        a.currentTime = (target - pieces[idx].startSample) / SAMPLE_RATE;
      } catch {
        /* not seekable yet */
      }
      a.removeEventListener('loadedmetadata', seek);
    };
    a.addEventListener('loadedmetadata', seek);
    if (!userPaused) {
      void a.play().catch(() => {});
    }
    return;
  }
  // beyond received — wait for the stream (queued pieces are re-checked)
  pendingSkip = target;
  nextIdx = 0;
  if (audio && !audio.paused) audio.pause();
  setPhase('loading');
}

export function rateSpeech(rate: number): void {
  set({ rate });
  if (audio) audio.playbackRate = rate;
}

/** Kill everything. */
export function stopSpeech(): void {
  gen++;
  abort?.abort();
  abort = null;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
  }
  for (const p of pieces) URL.revokeObjectURL(p.url);
  pieces = [];
  curIdx = -1;
  nextIdx = 0;
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

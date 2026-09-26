/** Singleton TTS deck player (the "speak last reply" dock in the session).
 *  Streams the message as speech in sentence chunks with pause/resume, seek
 *  across the whole message, and 1x/1.5x/2x speed. UI subscribes to the store
 *  via useSyncExternalStore; phases: idle → loading → playing ⇄ paused. */

export type SpeechPhase = 'idle' | 'loading' | 'playing' | 'paused';
export type SpeechState = {
  phase: SpeechPhase;
  /** played position, 0..1 across the whole message */
  progress: number;
  /** cached frontier, 0..1 — the bar renders stripes from here to 1 */
  cachedTo: number;
  /** text of the chunk under the playhead */
  excerpt: string;
  rate: number;
};

type Chunk = { text: string; url?: string; est?: number };

let chunks: Chunk[] = [];
let gen = 0; // generation token — bumped by stopSpeech() to cancel in-flight work
let el: HTMLAudioElement | null = null;
let curIdx = 0;
let pausedWanted = false;
let fetching = false;

let state: SpeechState = { phase: 'idle', progress: 0, cachedTo: 0, excerpt: '', rate: 1 };
const subs = new Set<() => void>();
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

/** Strip markdown the voice must not read, then split into sentence chunks.
 *  First chunk = first sentence only (≤130 chars → ~2.5-3s to first audio);
 *  the rest run 240 chars (~16s of speech, ~5.5s of synthesis each — RTF
 *  ~0.4 means every chunk banks ~10s of buffer for the pipeline). */
function chunkForSpeech(text: string, maxChars = 4000): string[] {
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
    .slice(0, maxChars);
  if (!clean) return [];
  const pack = (s: string, target: number): string[] => {
    const sentences = s.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [s];
    const out: string[] = [];
    let buf = '';
    for (const sent of sentences) {
      if (buf && (buf + sent).length > target) {
        out.push(buf.trim());
        buf = '';
      }
      buf += sent;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  };
  // peel the first sentence so playback starts after one short synthesis
  const first = clean.match(/^[^.!?…]+[.!?…]+["')\]]*\s*/)?.[0] ?? '';
  if (first && first.trim().length <= 130) {
    return [first.trim(), ...pack(clean.slice(first.length), 240)];
  }
  return pack(clean, 240);
}

function cachedFraction(): number {
  for (let i = 0; i < chunks.length; i++) if (!chunks[i].url) return i / chunks.length;
  return 1;
}

// deduped background prefetch — the Mac serializes synthesis under its own
// lock anyway, so firing several ahead just keeps the model continuously fed;
// the queue absorbs rate spikes (1.5x/2x) without starving the playhead
const pending = new Map<number, Promise<boolean>>();
const PREFETCH_AHEAD = 4;
function prefetch(i: number, myGen: number): Promise<boolean> {
  if (i >= chunks.length) return Promise.resolve(false);
  let p = pending.get(i);
  if (!p) {
    p = fetchChunk(i, myGen).finally(() => pending.delete(i));
    pending.set(i, p);
  }
  return p;
}

let startedAt = 0;
let curSlug = '';
// language of the CURRENT message, detected once on the full text — per-chunk
// detection made the proxy flip voices on chunks without French markers
// (lists "1. 2. 3.", short lines, code) — the speaker must not alternate
let msgLang: 'fr' | 'en' = 'en';
const frRe = /[àâçéèêëîïôùûüœ]/i;
// broad list: the user speaks franglais — tech verbs + everyday words must
// count as French even inside English sentences
const frWords =
  /\b(le|la|les|un|une|des|du|et|est|que|qui|pour|avec|dans|pas|vous|je|sur|au|aux|ce|cette|mais|plus|tout|tous|par|comme|il|elle|on|nous|son|sa|ses|ne|se|en|y|déjà|très|alors|donc|corriger|corrige|corrigé|déployer|déploie|déployé|deploye|tester|testé|essayer|essaye|changer|changé|marche|marché|voix|voix|faut|était|étai|peux|veux|vais|aller|faire|dire|savoir|prendre|mettre|donner|trouver|laisser|passer|rester|devenir|revenir|aider|regarder|demander|répondre|comprendre|apprendre|utiliser|travailler|commencer|finir|choisir|recevoir|écrire|voilà|oui|non|bon|merci|parce|pendant|depuis|encore|aussi|besoin|envie|ok)\b/i;

function detectLang(s: string): 'fr' | 'en' {
  if (frRe.test(s)) return 'fr';
  const fr = (s.toLowerCase().match(new RegExp(frWords.source, 'gi')) || []).length;
  const en = (
    s.toLowerCase().match(/\b(the|and|is|are|you|for|with|this|that|have|not|was|from|but|they|will|can|what|when|how|should|would|there|then|again)\b/gi) || []
  ).length;
  // franglais → prefer French: accented chars win outright, otherwise one
  // French marker is enough to tie-break (the user's messages are French-first)
  return fr >= 1 && fr >= en ? 'fr' : 'en';
}

// duration estimates per chunk (fetched: exact from wav size; unfetched:
// ~0.065s/char from the measured RTF) — makes seek/progress correct even
// with the small first chunk + big rest mix
function estOf(i: number): number {
  const c = chunks[i];
  if (!c) return 0.1;
  return c.est ?? Math.max(0.5, c.text.length * 0.065);
}
function cumEst(i: number): number {
  let t = 0;
  for (let k = 0; k < i && k < chunks.length; k++) t += estOf(k);
  return t;
}
function totalEst(): number {
  return cumEst(chunks.length);
}

async function fetchChunk(i: number, myGen: number): Promise<boolean> {
  const c = chunks[i];
  if (c.url) return true;
  try {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: c.text, lang: msgLang }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const blob = await r.blob();
    if (myGen !== gen) return false;
    c.url = URL.createObjectURL(blob);
    // 24kHz 16-bit mono WAV: bytes ≈ samples*2 + 44 header — duration without
    // waiting for metadata (keeps seek/progress math instant)
    c.est = Math.max(0.2, (blob.size - 44) / 48_000);
    set({ cachedTo: cachedFraction() });
    return true;
  } catch (e) {
    if (myGen === gen) {
      console.warn('tts chunk failed:', String(e)); // lands in the diag log
      stopSpeech();
    }
    return false;
  }
}

function updateProgress() {
  if (!el || !chunks.length) return;
  const durEff =
    Number.isFinite(el.duration) && el.duration > 0 ? el.duration : estOf(curIdx);
  const frac = durEff > 0 ? Math.min(1, el.currentTime / durEff) : 0;
  set({ progress: (cumEst(curIdx) + frac * estOf(curIdx)) / totalEst() });
}

async function playChunk(i: number, fracIn = 0) {
  const myGen = gen;
  curIdx = i;
  set({
    excerpt: chunks[i].text,
    progress: (cumEst(i) + fracIn * estOf(i)) / totalEst(),
  });
  try {
    fetching = true;
    const ok = await prefetch(i, myGen);
    fetching = false;
    if (myGen !== gen || !ok) return;
    // keep the pipeline full: the next chunks synthesize while this one
    // plays — with 240-char chunks (~16s audio, ~5.5s synth each) even 2x
    // playback stays ahead of the serial server
    for (let k = 1; k <= PREFETCH_AHEAD; k++) void prefetch(i + k, myGen);
    // one element for the whole message — created ONCE here (a null el here
    // used to throw post-fetch and leave the deck stuck in 'loading' forever)
    el ??= new Audio();
    const a = el;
    a.volume = 1; // never inherit a leftover unlock volume
    a.src = chunks[i].url!;
    a.playbackRate = state.rate;
    a.ontimeupdate = updateProgress;
    a.onloadedmetadata = () => {
      // mid-chunk seek: land at the requested offset once duration is known
      if (myGen !== gen || fracIn <= 0) return;
      try {
        if (Number.isFinite(a.duration) && a.duration > 0) a.currentTime = a.duration * fracIn;
      } catch {
        /* not seekable yet */
      }
    };
    a.onended = () => {
      if (myGen !== gen) return;
      if (i + 1 < chunks.length) void playChunk(i + 1);
      else stopSpeech(); // natural end
    };
    if (pausedWanted) {
      set({ phase: 'paused' });
      return;
    }
    await a.play();
    if (myGen === gen) {
      if (i === 0 && startedAt) {
        // metric: tap → first audio (lands in the diag log)
        console.warn(`tts: first audio in ${Date.now() - startedAt}ms (${chunks.length} chunks)`);
        startedAt = 0;
      }
      set({ phase: 'playing' });
    }
  } catch (e) {
    // ANY failure must be visible (deck returns to idle + diag), never a hang
    if (myGen === gen) {
      console.warn('tts playChunk failed:', String(e));
      stopSpeech();
    }
  }
}

let unlocked = false;
/** Must run synchronously inside the user's tap: plays a silent wav through
 *  the element once so iOS/Safari allows the programmatic play() that happens
 *  after the async chunk-fetch gap (gesture context is expired by then). */
function unlockAudio(): void {
  if (unlocked) return;
  unlocked = true;
  el ??= new Audio();
  el.src =
    'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  el.volume = 0.01;
  void el.play().catch(() => {});
  el.volume = 1; // restore — this element IS the player afterwards
}

/** Start speaking `text` from the beginning (stops any current playback).
 *  `slug` is reserved for per-session voice prefs. */
export function startSpeech(text: string, slug = ''): void {
  const parts = chunkForSpeech(text);
  if (!parts.length) return;
  stopSpeech();
  unlockAudio();
  chunks = parts.map((t) => ({ text: t }));
  pausedWanted = false;
  startedAt = Date.now();
  curSlug = slug;
  msgLang = detectLang(text.slice(0, 600)); // ONE language per message
  set({ phase: 'loading', progress: 0, cachedTo: 0, excerpt: chunks[0].text });
  void playChunk(0);
}

export function pauseSpeech(): void {
  if (state.phase !== 'playing') return;
  pausedWanted = true; // also covers a fetch in flight — hold before autoplay
  el?.pause();
  set({ phase: 'paused' });
}

export function resumeSpeech(): void {
  if (state.phase !== 'paused') return;
  pausedWanted = false;
  if (el && el.src) {
    void el.play().catch((e) => console.warn('tts resume failed:', String(e)));
  }
  set({ phase: 'playing' });
}

/** Seek to `fraction` (0..1) across the whole message, weighted by each
 *  chunk's estimated duration. Backward/within-cache is instant; forward
 *  into un-synthesized text synthesizes first, then plays. */
export function seekSpeech(fraction: number): void {
  if (state.phase === 'idle' || !chunks.length) return;
  const frac = Math.min(0.999, Math.max(0, fraction));
  // map fraction → (chunk, offset) via cumulative duration estimates
  const target = frac * totalEst();
  let i = 0;
  while (i < chunks.length - 1 && cumEst(i + 1) <= target) i++;
  const fracIn =
    estOf(i) > 0 ? Math.min(1, Math.max(0, (target - cumEst(i)) / estOf(i))) : 0;
  const wasPaused = pausedWanted || state.phase === 'paused';
  const curDur = el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : estOf(curIdx);
  if (i === curIdx && el && el.src && curDur > 0) {
    // same chunk — jump without touching the network
    try {
      el.currentTime = curDur * fracIn;
    } catch {
      /* not seekable yet */
    }
    set({ progress: frac });
    return;
  }
  pausedWanted = wasPaused;
  void playChunk(i, fracIn);
}

export function rateSpeech(rate: number): void {
  set({ rate });
  if (el) el.playbackRate = rate;
}

/** Kill everything (also the natural-end path): cancels in-flight fetches. */
export function stopSpeech(): void {
  gen++;
  pausedWanted = false;
  fetching = false;
  if (el) {
    el.onended = null;
    el.ontimeupdate = null;
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
  for (const c of chunks) if (c.url) URL.revokeObjectURL(c.url);
  chunks = [];
  curIdx = 0;
  if (state.phase !== 'idle') set({ phase: 'idle', progress: 0, cachedTo: 0, excerpt: '' });
}

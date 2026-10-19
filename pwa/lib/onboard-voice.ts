/** The door's voice: pre-recorded lines in the app's own voice (af_heart /
 *  Elise — public/onboarding, rendered by scripts/onboard-voice.mjs from
 *  lib/onboard-script.json). No brain, no TTS round-trip: first audio is a
 *  file already in memory.
 *
 *  ONE native <audio> element for every line (phones suspend WebAudio in the
 *  background — same choice as lib/speech.ts). Its first play() happens inside
 *  a gesture (the release on the tree), which unlocks it for the lines that
 *  play later without one (heard / in / not_heard in MAIN).
 *
 *  Fallback chain per line: the file → live /api/tts/stream with the same
 *  text (the app's reply voice) → text only (the caption is always on screen).
 *  Every first audio and every miss lands in diag: `prerender <id> …`. */
import { diagEvent } from '@/lib/diag';
import { type Lang, line, lineSrc } from '@/lib/tree-first';

let el: HTMLAudioElement | null = null;
let unlocked = false;
let gen = 0;
let liveUrl: string | null = null;
/** the line in flight resolves 'stopped' when a newer one (or stopLine) cuts it */
let cut: (() => void) | null = null;
const cache = new Map<string, Promise<string>>(); // src → blob url

function audio(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
  }
  return el;
}

/** Fetch lines into memory ahead of their step (cheap: ~20 KB each). */
export function warmLines(ids: string[], lang: Lang): void {
  if (typeof window === 'undefined') return;
  for (const id of ids) {
    const src = lineSrc(id, lang);
    if (cache.has(src)) continue;
    const p = fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.blob();
      })
      .then((b) => URL.createObjectURL(b));
    p.catch(() => cache.delete(src)); // a miss retries on play
    cache.set(src, p);
  }
}

const SILENT =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

/** Call from a gesture handler (pointerup / click): lets later lines play
 *  without one. No-op once a line has played. */
export function unlockLines(): void {
  if (unlocked || typeof window === 'undefined') return;
  const a = audio();
  if (a.src && !a.paused) return;
  a.src = SILENT;
  a.play()
    .then(() => {
      unlocked = true;
    })
    .catch(() => {});
}

export function stopLine(): void {
  gen++;
  cut?.();
  if (el) {
    el.pause();
    el.removeAttribute('src');
  }
}

/** PCM int16 (the stream route) → a playable wav blob url */
function wavUrl(pcm: ArrayBuffer, rate: number): string {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  h.setUint32(4, 36 + pcm.byteLength, true);
  w(8, 'WAVEfmt ');
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  w(36, 'data');
  h.setUint32(40, pcm.byteLength, true);
  return URL.createObjectURL(new Blob([h.buffer, pcm], { type: 'audio/wav' }));
}

async function live(id: string, lang: Lang): Promise<string> {
  const r = await fetch('/api/tts/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: line(id, lang), lang }), // lang always explicit
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`live tts ${r.status}`);
  const rate = Number(r.headers.get('X-Sample-Rate')) || 24000;
  if (liveUrl) URL.revokeObjectURL(liveUrl);
  liveUrl = wavUrl(await r.arrayBuffer(), rate);
  return liveUrl;
}

function playUrl(url: string): Promise<'ended' | 'stopped'> {
  const a = audio();
  cut?.();
  return new Promise((resolve, reject) => {
    const off = () => {
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('error', onErr);
      if (cut === stop) cut = null;
    };
    const onEnd = () => {
      off();
      resolve('ended');
    };
    const onErr = () => {
      off();
      reject(new Error('decode'));
    };
    const stop = () => {
      off();
      resolve('stopped');
    };
    cut = stop;
    a.addEventListener('ended', onEnd);
    a.addEventListener('error', onErr);
    a.src = url;
    a.play().then(
      () => {
        unlocked = true;
      },
      (e) => {
        off();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

export type SayResult = 'file' | 'live' | 'text' | 'stopped';

/** Speak one line; resolves when it ended (or was cut / fell back to text).
 *  A newer say() or stopLine() cuts this one. */
export async function say(id: string, lang: Lang): Promise<SayResult> {
  if (typeof window === 'undefined') return 'text';
  const my = ++gen;
  cut?.();
  const t0 = performance.now();
  const a = audio();
  a.pause();
  const first = () => {
    a.removeEventListener('playing', first);
    if (gen === my) diagEvent('voice', `prerender ${id} ${lang} first audio ${Math.round(performance.now() - t0)}ms`);
  };
  a.addEventListener('playing', first);
  const src = lineSrc(id, lang);
  try {
    warmLines([id], lang);
    const url = await cache.get(src)!;
    if (gen !== my) return 'stopped';
    const end = await playUrl(url);
    return end === 'ended' ? 'file' : 'stopped';
  } catch (e) {
    if (gen !== my) return 'stopped';
    const why = e instanceof Error ? e.message : String(e);
    diagEvent('voice', `prerender miss ${id} ${lang} ${why}`);
    // NotAllowedError = no gesture yet: live TTS would hit the same wall
    if (/NotAllowed/i.test(why)) return 'text';
  }
  try {
    const url = await Promise.race([
      live(id, lang),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no first audio in 3s')), 3_000)),
    ]);
    if (gen !== my) return 'stopped';
    const end = await playUrl(url);
    return end === 'ended' ? 'live' : 'stopped';
  } catch (e) {
    a.removeEventListener('playing', first);
    if (gen === my) diagEvent('voice', `prerender live miss ${id} ${lang} ${e instanceof Error ? e.message : e} — text only`);
    return gen === my ? 'text' : 'stopped';
  }
}

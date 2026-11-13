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
 *  Every first audio and every miss lands in diag: `prerender <id> …`.
 *
 *  No dead air (FILM-V1, 10-22): the voice says what it is doing, so the
 *  screen can — `loading` from the instant a line is asked for until its
 *  first audio frame ('playing'), `speaking` while it plays, `quiet` when no
 *  sound could play (the words are on screen), else `idle`. Never ahead of
 *  the audio: `speaking` is the element's own event, not a guess. */
import { useSyncExternalStore } from 'react';
import { diagEvent } from '@/lib/diag';
import { type Lang, line, lineSrc } from '@/lib/tree-first';

export type VoiceState = 'idle' | 'loading' | 'speaking' | 'quiet';
let vstate: VoiceState = 'idle';
const vsubs = new Set<() => void>();
function setVoice(s: VoiceState): void {
  if (vstate === s) return;
  vstate = s;
  vsubs.forEach((f) => f());
}
function subscribeVoice(f: () => void): () => void {
  vsubs.add(f);
  return () => vsubs.delete(f);
}
/** what the door's voice is doing right now — re-renders on every change */
export function useVoiceState(): VoiceState {
  return useSyncExternalStore(subscribeVoice, () => vstate, () => 'idle');
}

let el: HTMLAudioElement | null = null;
let unlocked = false;
let gen = 0;
let liveUrl: string | null = null;
/** the line in flight resolves 'stopped' when a newer one (or stopLine) cuts it */
let cut: (() => void) | null = null;
const cache = new Map<string, Promise<string>>(); // src → blob url
const blobs = new Map<string, Promise<Blob>>(); // src → the file itself (handed to the film)

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
    const b = fetch(src).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.blob();
    });
    const p = b.then((x) => URL.createObjectURL(x));
    p.catch(() => {
      cache.delete(src); // a miss retries on play
      blobs.delete(src);
    });
    cache.set(src, p);
    blobs.set(src, b);
  }
}

/** A line's file from memory (fetched now if it isn't yet) — for a sandboxed
 *  film, which has no origin to fetch the pack from itself. null = no file. */
export async function lineBlob(id: string, lang: Lang): Promise<Blob | null> {
  if (typeof window === 'undefined') return null;
  warmLines([id], lang);
  return blobs.get(lineSrc(id, lang))?.catch(() => null) ?? null;
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
  setVoice('idle');
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
  setVoice('loading'); // this frame: the line is asked for, its sound is on the way
  const first = () => {
    if (a.src === SILENT) return; // the unlock's silence is not this line
    a.removeEventListener('playing', first);
    if (gen !== my) return;
    setVoice('speaking');
    diagEvent('voice', `prerender ${id} ${lang} first audio ${Math.round(performance.now() - t0)}ms`);
  };
  a.addEventListener('playing', first);
  const done = (r: SayResult): SayResult => {
    if (gen === my) setVoice(r === 'text' ? 'quiet' : 'idle');
    return r;
  };
  const src = lineSrc(id, lang);
  try {
    warmLines([id], lang);
    const url = await cache.get(src)!;
    if (gen !== my) return 'stopped';
    const end = await playUrl(url);
    return done(end === 'ended' ? 'file' : 'stopped');
  } catch (e) {
    if (gen !== my) return 'stopped';
    const why = e instanceof Error ? e.message : String(e);
    diagEvent('voice', `prerender miss ${id} ${lang} ${why}`);
    // NotAllowedError = no gesture yet: live TTS would hit the same wall
    if (/NotAllowed/i.test(why)) {
      a.removeEventListener('playing', first);
      return done('text');
    }
  }
  try {
    const url = await Promise.race([
      live(id, lang),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no first audio in 3s')), 3_000)),
    ]);
    if (gen !== my) return 'stopped';
    const end = await playUrl(url);
    return done(end === 'ended' ? 'live' : 'stopped');
  } catch (e) {
    a.removeEventListener('playing', first);
    if (gen === my) diagEvent('voice', `prerender live miss ${id} ${lang} ${e instanceof Error ? e.message : e} — text only`);
    return gen === my ? done('text') : 'stopped';
  }
}

/**
 * Streaming TTS: POST { text, lang } → raw PCM stream (int16 LE, X-Sample-Rate
 * header, 24kHz). ONE continuous generation on the Mac for the whole message
 * (wrapper /v1/audio/speech_stream) — the speaker is physically constant, no
 * chunk boundaries. Pure pass-through; the phone never touches the LAN.
 *
 * Stutter diagnostics (M0): the pass-through is tapped — every chunk's
 * arrival gap (Mac→box) and write time (box→phone) is recorded; one JSON
 * summary line lands in .diag/tts-YYYY-MM-DD.log keyed by the client's sid
 * (same id in the client's tts-chunk diag events) so both legs of one reply
 * can be correlated. 24k int16 = 48,000 bytes of audio per second.
 */
import { NextResponse } from 'next/server';
import { appendFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';

export const dynamic = 'force-dynamic';

const BYTES_PER_SEC = 48_000; // 24kHz × 2 bytes (int16 LE mono)
const DIAG_DIR = path.join(process.cwd(), '.diag');

const BASE = process.env.SPEACHES_URL || '';
const MODEL_FR = process.env.TTS_MODEL_FR || 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16';
const VOICE_FR = process.env.TTS_VOICE_FR || 'serena';
// English: Kokoro-82M — native English female/male voices (lang codes are
// single letters: a=American, b=British, f=French — 'auto' is invalid there)
const MODEL_EN = process.env.TTS_MODEL_EN || 'mlx-community/Kokoro-82M-bf16';
const VOICE_EN = process.env.TTS_VOICE_EN || 'af_heart';
const LANG_EN = process.env.TTS_LANG_EN || 'a';

export async function POST(req: Request) {
  if (!BASE) return NextResponse.json({ error: 'SPEACHES_URL not configured' }, { status: 500 });
  try {
    const { text, lang, seed, sid } = (await req.json()) as {
      text?: string;
      lang?: 'fr' | 'en';
      seed?: number;
      sid?: string;
    };
    const input = (text || '').slice(0, 4000);
    if (!input.trim()) return NextResponse.json({ error: 'empty text' }, { status: 400 });
    const french = lang === 'fr' ? true : lang === 'en' ? false : true; // franglais → French
    const body = french
      ? {
          model: MODEL_FR,
          voice: VOICE_FR,
          lang_code: 'french',
          temperature: 0.2,
          top_k: 20,
          repetition_penalty: 1.3,
          streaming_interval: 4.0,
          seed: typeof seed === 'number' ? seed : undefined,
          input,
        }
      : {
          model: MODEL_EN,
          voice: VOICE_EN,
          lang_code: LANG_EN,
          temperature: 0.2,
          top_k: 20,
          repetition_penalty: 1.3,
          streaming_interval: 4.0,
          input,
        };
    const up = await fetch(`${BASE}/audio/speech_stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    });
    if (!up.ok || !up.body) {
      const detail = await up.text().catch(() => '');
      return NextResponse.json(
        { error: `tts upstream ${up.status}${detail ? `: ${detail.slice(0, 120)}` : ''}` },
        { status: 502 }
      );
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Sample-Rate': up.headers.get('X-Sample-Rate') || '24000',
    };
    const spk = up.headers.get('X-Spk-Emb');
    if (spk) headers['X-Spk-Emb'] = spk;
    if (sid) headers['X-Tts-Sid'] = sid;
    // ---- stutter metrics: tap the pass-through ----
    const t0 = performance.now();
    let ttfc = 0;
    let last = 0;
    let bytes = 0;
    const gaps: number[] = [];
    const tap = new TransformStream({
      transform(chunk: Uint8Array, controller) {
        const now = performance.now();
        if (!ttfc) {
          ttfc = now - t0; // first body byte: synthesis of the first chunk + fetch
        } else {
          gaps.push(Math.round(now - last));
        }
        last = now;
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        // fire & forget: the summary must never delay/destroy the stream tail
        const totalMs = Math.round(performance.now() - t0);
        const audioSec = +(bytes / BYTES_PER_SEC).toFixed(2);
        const maxGap = gaps.length ? Math.max(...gaps) : 0;
        const avgGap = gaps.length
          ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
          : 0;
        // rtf > 1 ⇒ the Mac produced audio slower than realtime ⇒ playback
        // underruns regardless of the network; load = box loadavg[0] for context
        const rtf = audioSec > 0 ? +(totalMs / 1000 / audioSec).toFixed(2) : 0;
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          sid: sid || '-',
          lang: lang || 'auto',
          chars: input.length,
          bytes,
          audioSec,
          fetchMs: Math.round(ttfc || 0),
          totalMs,
          rtf,
          chunks: gaps.length + 1,
          avgGap,
          maxGap,
          load: +os.loadavg()[0].toFixed(2),
          gaps: gaps.slice(0, 120),
        });
        void mkdir(DIAG_DIR, { recursive: true })
          .then(() =>
            appendFile(
              path.join(DIAG_DIR, `tts-${new Date().toISOString().slice(0, 10)}.log`),
              line + '\n'
            )
          )
          .catch(() => {});
        console.log(`[tts-metrics] ${line}`);
      },
    });
    return new Response(up.body!.pipeThrough(tap), { headers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

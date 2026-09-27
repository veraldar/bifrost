/**
 * Streaming TTS: POST { text, lang } → raw PCM stream (int16 LE, X-Sample-Rate
 * header, 24kHz). ONE continuous generation on the Mac for the whole message
 * (wrapper /v1/audio/speech_stream) — the speaker is physically constant, no
 * chunk boundaries. Pure pass-through; the phone never touches the LAN.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const BASE = process.env.SPEACHES_URL || '';
const MODEL_FR = process.env.TTS_MODEL_FR || 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16';
const MODEL = process.env.TTS_MODEL || 'cr2k2/Qwen3-TTS-12Hz-1.7B-Base-fp32';
const VOICE_FR = process.env.TTS_VOICE_FR || 'serena';

export async function POST(req: Request) {
  if (!BASE) return NextResponse.json({ error: 'SPEACHES_URL not configured' }, { status: 500 });
  try {
    const { text, lang } = (await req.json()) as { text?: string; lang?: 'fr' | 'en' };
    const input = (text || '').slice(0, 4000);
    if (!input.trim()) return NextResponse.json({ error: 'empty text' }, { status: 400 });
    const french = lang === 'fr' ? true : lang === 'en' ? false : true; // franglais → French
    const body = french
      ? {
          model: MODEL_FR,
          voice: VOICE_FR,
          lang_code: 'french',
          temperature: 0.3,
          top_k: 20,
          repetition_penalty: 1.3,
          streaming_interval: 4.0,
          input,
        }
      : {
          model: MODEL,
          voice: 'default',
          lang_code: 'auto',
          temperature: 0.3,
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
    return new Response(up.body, { headers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

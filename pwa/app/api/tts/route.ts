/**
 * TTS proxy: POST { text } → audio/wav from the Mac Studio's OpenAI-compatible
 * MLX voice server (SPEACHES_URL). Same endpoint family the livekit agent uses.
 * The phone never talks to the LAN directly — this proxy is the only seam,
 * like /api/session/*.
 *
 * Language routing: French text goes to the VoiceDesign model with a native-
 * French instruct — the default "base" model clones an English reference
 * speaker (ref_voice.wav), which reads French with a heavy English accent.
 * English keeps the base voice. Body is streamed straight through; the client
 * chunks long texts into sequential requests itself (pseudo-streaming).
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const BASE = process.env.SPEACHES_URL || '';
const MODEL = process.env.TTS_MODEL || 'cr2k2/Qwen3-TTS-12Hz-1.7B-Base-fp32';
// French: Qwen3-TTS CustomVoice — PRESET speaker = deterministic voice (same
// speaker every request). The base model clones an English reference speaker
// (English accent), and VoiceDesign invents a random voice per request —
// both unusable for constant French. lang_code must be explicit: the wrapper
// would otherwise force "en".
const MODEL_FR = process.env.TTS_MODEL_FR || 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16';
const VOICE_FR = process.env.TTS_VOICE_FR || 'serena';
const LANG_FR = process.env.TTS_LANG_FR || 'french';

/** Diacritics are decisive; otherwise French vs English function-word counts. */
function isFrench(s: string): boolean {
  const lower = s.toLowerCase();
  if (/[àâçéèêëîïôùûüœ]/.test(lower)) return true;
  const fr = (
    lower.match(
      /\b(le|la|les|un|une|des|du|et|est|que|qui|pour|avec|dans|pas|vous|je|sur|au|aux|ce|cette|mais|plus|tout|tous|par|comme|il|elle|on|nous|son|sa|ses|ne|se|en|y|déjà|très|alors|donc)\b/g
    ) || []
  ).length;
  const en = (
    lower.match(
      /\b(the|and|is|are|you|for|with|this|that|have|not|was|from|but|they|will|can|what|when|how|all|your|we|are)\b/g
    ) || []
  ).length;
  return fr >= 2 && fr > en;
}

export async function POST(req: Request) {
  if (!BASE) return NextResponse.json({ error: 'SPEACHES_URL not configured' }, { status: 500 });
  try {
    const { text, lang } = (await req.json()) as { text?: string; lang?: 'fr' | 'en' };
    const input = (text || '').slice(0, 600); // server-side cap per request
    if (!input.trim()) return NextResponse.json({ error: 'empty text' }, { status: 400 });
    // the CLIENT detects the language once per message — per-chunk detection
    // here would flip voices on chunks without French markers (lists, code)
    const french = lang === 'fr' ? true : lang === 'en' ? false : isFrench(input);
    const body: Record<string, unknown> = french
      ? {
          model: MODEL_FR,
          voice: VOICE_FR,
          lang_code: LANG_FR,
          // sampling kept tight: the qwen3 preset speaker drifts between
          // female/male registers at the model defaults (temp 0.7/top_k 50);
          // top_k=1 degenerates into repetition loops. 0.3/20/1.3 stays in
          // the speaker's register without looping (measured via F0).
          temperature: 0.3,
          top_k: 20,
          repetition_penalty: 1.3,
          input,
        }
      : // force 'en' explicitly — the wrapper default ('auto') makes the model
        // switch language per segment on franglais text, which sounds like the
        // voice changing mid-message. Same tight sampling as the French path.
        {
          model: MODEL,
          voice: 'default',
          lang_code: 'en',
          temperature: 0.3,
          top_k: 20,
          repetition_penalty: 1.3,
          input,
        };
    const up = await fetch(`${BASE}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!up.ok || !up.body) {
      const detail = await up.text().catch(() => '');
      return NextResponse.json(
        { error: `tts upstream ${up.status}${detail ? `: ${detail.slice(0, 120)}` : ''}` },
        { status: 502 }
      );
    }
    return new Response(up.body, {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

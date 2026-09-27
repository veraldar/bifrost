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

/** Trim leading/trailing silence from a 24kHz 16-bit mono WAV, keeping
 *  ~120ms of padding. The model pads chunks with silence that stacks into
 *  audible pauses between chunks. Returns the original buffer if parsing
 *  fails or the clip is (near-)empty. */
function trimSilence(buf: ArrayBuffer): Buffer {
  const b = Buffer.from(buf);
  try {
    // locate the 'data' chunk (RIFF may pad odd-sized chunks)
    let pos = 12;
    let dataOff = -1;
    let dataLen = 0;
    while (pos + 8 <= b.length) {
      const id = b.toString('ascii', pos, pos + 4);
      const size = b.readUInt32LE(pos + 4);
      if (id === 'data') {
        dataOff = pos + 8;
        dataLen = Math.min(size, b.length - dataOff);
        break;
      }
      pos += 8 + size + (size % 2);
    }
    if (dataOff < 0 || dataLen < 4800) return b; // <0.1s — nothing to trim
    const n = Math.floor(dataLen / 2);
    const thr = 250; // ~0.008 full scale
    let first = 0;
    let last = n - 1;
    while (first < n && Math.abs(b.readInt16LE(dataOff + first * 2)) < thr) first++;
    while (last > first && Math.abs(b.readInt16LE(dataOff + last * 2)) < thr) last--;
    if (last - first < n * 0.05) return b; // mostly silent — leave it alone
    const pad = Math.round(0.12 * 24000);
    first = Math.max(0, first - pad);
    last = Math.min(n - 1, last + pad);
    const outBytes = (last - first + 1) * 2;
    const head = Buffer.from(b.subarray(0, dataOff));
    head.writeUInt32LE(outBytes, dataOff - 4); // data chunk size
    head.writeUInt32LE(36 + outBytes, 4); // riff size
    return Buffer.concat([head, b.subarray(dataOff + first * 2, dataOff + (last + 1) * 2)]);
  } catch {
    return b;
  }
}

export async function POST(req: Request) {
  if (!BASE) return NextResponse.json({ error: 'SPEACHES_URL not configured' }, { status: 500 });
  try {
    const { text, lang, spkEmb } = (await req.json()) as {
      text?: string;
      lang?: 'fr' | 'en';
      spkEmb?: string;
    };
    const input = (text || '').slice(0, 600); // server-side cap per request
    if (!input.trim()) return NextResponse.json({ error: 'empty text' }, { status: 400 });
    // the CLIENT detects the language once per message — per-chunk detection
    // here would flip voices on chunks without French markers (lists, code)
    const french = lang === 'fr' ? true : lang === 'en' ? false : isFrench(input);
    // French: CustomVoice 'serena' + explicit language + wrapper-side speaker-
    // embedding gate (the client anchors on chunk 1's embedding; drifted
    // chunks are regenerated server-side until they match). force 'en' on the
    // base path — the wrapper default ('auto') flips language per segment on
    // franglais text, which sounds like the voice changing mid-message.
    const body: Record<string, unknown> = french
      ? {
          model: MODEL_FR,
          voice: VOICE_FR,
          lang_code: LANG_FR,
          temperature: 0.3,
          top_k: 20,
          repetition_penalty: 1.3,
          want_emb: true,
          emb_thresh: 0.9,
          input,
        }
      : {
          model: MODEL,
          voice: 'default',
          lang_code: 'en',
          temperature: 0.3,
          top_k: 20,
          repetition_penalty: 1.3,
          input,
        };
    if (french && spkEmb) {
      // client forwards the session's anchored speaker embedding
      body.ref_emb = spkEmb.trim();
      body.emb_thresh = 0.93;
    }
    const up = await fetch(`${BASE}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    if (!up.ok) {
      const detail = await up.text().catch(() => '');
      return NextResponse.json(
        { error: `tts upstream ${up.status}${detail ? `: ${detail.slice(0, 120)}` : ''}` },
        { status: 502 }
      );
    }
    const trimmed = trimSilence(await up.arrayBuffer());
    const headers: Record<string, string> = {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
    };
    const spk = up.headers.get('X-Spk-Emb');
    if (spk) headers['X-Spk-Emb'] = spk;
    return new Response(new Uint8Array(trimmed), { headers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

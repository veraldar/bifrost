/**
 * TTS proxy: POST { text, lang? } → audio/wav from the Mac Studio's
 * OpenAI-compatible MLX voice server (SPEACHES_URL). The phone never talks
 * to the LAN directly — this proxy is the only seam, like /api/session/*.
 */
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/** Current build id + TTS voice — the client auto-reloads when the build
 *  changes (stale PWA tabs keep running old JS for days otherwise), and
 *  namespaces the speaker-anchor storage by voice. */
export async function GET() {
  let id = 'unknown';
  try {
    id = (
      await fs.readFile(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')
    ).trim();
  } catch {
    /* keep 'unknown' */
  }
  return NextResponse.json({
    id,
    ttsVoice: process.env.TTS_VOICE_FR || 'serena',
  });
}

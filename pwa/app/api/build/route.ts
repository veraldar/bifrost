/**
 * TTS proxy: POST { text, lang? } → audio/wav from the Mac Studio's
 * OpenAI-compatible MLX voice server (SPEACHES_URL). The phone never talks
 * to the LAN directly — this proxy is the only seam, like /api/session/*.
 */
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/** Current build id — the client auto-reloads when this changes (stale
 *  PWA tabs keep running old JS for days otherwise). */
export async function GET() {
  try {
    const id = (
      await fs.readFile(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')
    ).trim();
    return NextResponse.json({ id });
  } catch {
    return NextResponse.json({ id: 'unknown' });
  }
}

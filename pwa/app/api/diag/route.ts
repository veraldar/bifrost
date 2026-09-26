/** POST /api/diag → receive frontend diagnostic batches (console errors,
 *  crashes, network timings, taps) and log them: one summary line to
 *  journalctl, full events appended to pwa/.diag/diag-YYYY-MM-DD.log.
 *  GET  /api/diag → tail the most recent diag file (text/plain).
 *  Diagnostics are log-only; no automatic fix sessions are created. */
import { NextResponse } from 'next/server';
import { appendFile, mkdir, readFile, readdir } from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';

const DIR = path.join(process.cwd(), '.diag');
const TAIL_BYTES = 32 * 1024;

type Batch = {
  client?: string;
  page?: string;
  reason?: string;
  events?: { t: number; kind: string; msg: string }[];
};

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    const b = JSON.parse(raw) as Batch;
    const events = Array.isArray(b.events) ? b.events.slice(0, 500) : [];
    if (!events.length) return NextResponse.json({ ok: true, stored: 0 });

    const day = new Date().toISOString().slice(0, 10);
    const lines = events.map(
      (e) =>
        `${new Date(e.t).toISOString()} [${e.kind}] (${b.page || '?'} · ${b.client || 'anon'}) ${String(e.msg).slice(0, 2000)}`
    );
    await mkdir(DIR, { recursive: true });
    await appendFile(path.join(DIR, `diag-${day}.log`), lines.join('\n') + '\n');

    // server log gets the summary + anything alarming, verbatim
    const bad = events.filter((e) => e.kind !== 'net' && e.kind !== 'tap');
    console.log(
      `[diag] +${events.length} (${b.reason || '-'}) ${b.page || '?'} client=${b.client || 'anon'}`
    );
    for (const e of bad.slice(0, 10)) {
      console.log(`[diag] ${e.kind}: ${String(e.msg).slice(0, 300)}`);
    }
    return NextResponse.json({ ok: true, stored: events.length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET() {
  try {
    const files = (await readdir(DIR)).filter((f) => f.startsWith('diag-')).sort();
    if (!files.length) return new Response('(no diag logs yet)', { status: 200 });
    const latest = path.join(DIR, files[files.length - 1]);
    const stat = await readFile(latest);
    const tail = stat.length > TAIL_BYTES ? stat.subarray(stat.length - TAIL_BYTES) : stat;
    return new Response(tail.toString('utf8'), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch {
    return new Response('(no diag logs yet)', { status: 200 });
  }
}

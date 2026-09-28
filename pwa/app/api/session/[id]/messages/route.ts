/**
 * GET  /api/session/[id]/messages → transcript for one session
 * POST /api/session/[id]/prompt   → send text/images/files to the session
 */
import { NextResponse } from 'next/server';
import { ocFetch, resolveId } from '@/lib/oc';
import { bustCache } from '@/lib/oc-cache';
import { buildParts, forward, runEnded } from '@/lib/oc-forward';
import { isRunLive, liveSince, runEndedAt } from '@/lib/oc-live';
import { enqueue, queuedItems } from '@/lib/oc-queue';
import { bustSearchResults, bustTranscript } from '@/lib/oc-transcript';
import { ensureWatchdog } from '@/lib/oc-watchdog';
import { PENDING_TTL_MS } from '@/lib/pending-ttl';

export const dynamic = 'force-dynamic';

type SendBody = {
  text?: string;
  images?: string[];
  files?: { name: string; content: string }[];
};

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sid = await resolveId(id);
    const msgs = await ocFetch(`/session/${sid}/message`);
    const out = msgs.map((m: any) => {
      const text = (m.parts || [])
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text || '')
        .join('\n')
        .trim();
      // tool-only steps stay invisible on the phone: the busy indicator
      // already shows activity, ⚙ lines were just clutter (user req)
      return {
        role: m.info?.role || m.role,
        text,
        images: (m.parts || [])
          .filter((p: any) => p.type === 'image' || p.mime?.startsWith('image/'))
          .map((p: any) => p.url || p.data || null),
        time: m.info?.time?.created || 0,
        // assistant replies stream: time.completed only lands when the run
        // finished. The hands-free auto-listen must speak COMPLETE replies —
        // speaking a growing message mid-run reads out a fragment.
        done:
          (m.info?.role || m.role) === 'assistant' ? !!m.info?.time?.completed : undefined,
      };
    });
    const all = out.filter((m: any) => m.text || m.images.length);
    // run state for the busy indicator: opencode emits one assistant message
    // per step, so "an assistant message landed" ≠ "the run is done". The run
    // is done only when the last relevant message is an assistant message with
    // time.completed set (0 while a step is in progress or the last message
    // is the user's). State string lets the client detect "unchanged since
    // last poll" without trusting wall clocks.
    // The last RAW message alone lies when a follow-up prompt stacks on top
    // of an in-flight run: opencode persists the new user message instantly
    // and serializes its run behind the one still executing (voice turns
    // land seconds apart). Last-raw is then the stacked prompt (|0|user),
    // the client reads "runner never picked it up", and its 30s wedge guard
    // aborts a LIVE session — killing the in-flight run and the queued
    // prompt (opencode drops its queue on abort). Scan back for the last
    // assistant message: fresh and un-completed means a run is genuinely in
    // progress and IT is the true run state (|0|assistant). Stale debris
    // (crashed opencode) stays out via the same TTL the client arms with.
    let stateMsg = msgs[msgs.length - 1];
    for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 8; i--) {
      const m = msgs[i];
      if ((m.info?.role || m.role || '') !== 'assistant') continue;
      const done = m.info?.time?.completed || 0;
      if (
        !done &&
        (m.info?.time?.created || 0) > Date.now() - PENDING_TTL_MS
      ) {
        stateMsg = m;
      }
      break; // the LAST assistant message decides — older ones are history
    }
    const lastRole = stateMsg?.info?.role || stateMsg?.role || '';
    const lastDone = lastRole === 'assistant' ? stateMsg?.info?.time?.completed || 0 : 0;
    const runState = `${stateMsg?.info?.id || stateMsg?.id || 'none'}|${lastDone}|${lastRole}`;
    // self-heal zombie live entries: a proxy restart orphans the in-flight
    // POST, so nothing ever calls markRunEnd — blinking dot + "queued"
    // everything, forever. opencode serializes per session, so a last
    // assistant step completed >2min ago proves the run is over (live runs
    // legitimately pause between steps — the grace period guards those).
    if (isRunLive(sid) && lastDone > 0 && Date.now() - lastDone > 120_000) {
      console.log(
        `[oc] zombie run entry healed ${sid} (idle ${Math.round((Date.now() - lastDone) / 1000)}s)`
      );
      runEnded(sid, id);
    }
    // long sessions: default to the latest window, older pages load on demand
    const limit = Number(new URL(req.url).searchParams.get('limit') || 0);
    const body = limit > 0 ? all.slice(-limit) : all;
    // messages waiting in the proxy queue render like the transcript (with
    // queued: true) — refresh-proof, no client-side echo needed
    const queued = queuedItems(sid).map((q) => ({
      role: 'user',
      text: q.text,
      images: q.images,
      time: q.at,
      queued: true,
    }));
    return NextResponse.json([...body, ...queued], {
      headers: {
        'X-Total-Count': String(all.length),
        'X-Run-State': runState,
        // definitive live-run flag: the proxy tracks its own in-flight async
        // prompts — the client can't tell "thinking between steps" from "done"
        'X-Run-Live': isRunLive(sid) ? '1' : '0',
        // epoch ms the live run started (true elapsed across page refreshes)
        'X-Run-Live-Since': String(liveSince(sid) || 0),
        // epoch ms the last run finished — an authoritative "the run you are
        // waiting on is over" even when opencode leaves completed=0 behind
        'X-Run-Ended': String(runEndedAt(sid) || 0),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    ensureWatchdog(); // global-guarded across module graphs (oc-watchdog)
    const { id } = await ctx.params;
    const sid = await resolveId(id);
    const body = await req.json();
    const async = body.async === true;
    const parts = buildParts(body);
    if (!parts.length) return NextResponse.json({ error: 'empty' }, { status: 400 });

      if (async) {
      if (isRunLive(sid)) {
        // a run is in flight: hold the message in the proxy queue. opencode's
        // own queue stalls forever after an abort — here the run's end
        // (abort included) automatically forwards the next queued message
        enqueue(sid, {
          text: String(body.text || ''),
          images: body.images || [],
          files: body.files || [],
        });
        console.log(`[queue] enqueue ${sid} (depth ${queuedItems(sid).length})`);
        bustCache();
        bustTranscript(sid);
        bustSearchResults();
        return NextResponse.json({ queued: true });
      }
      // fire-and-forget: reply lands via transcript polling. The POST only
      // resolves when the whole run finishes — that window IS the live-run
      // flag, and its end fires Web Push (wakes a frozen phone) + cache bust
      forward(sid, id, body);
      bustCache();
      bustTranscript(sid);
      bustSearchResults();
      return NextResponse.json({ queued: true });
    }

    const reply = await ocFetch(`/session/${sid}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
    });
    bustCache();
    bustTranscript(sid);
    bustSearchResults();
    const out = (reply.parts || [])
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('\n')
      .trim();
    return NextResponse.json({ text: out });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

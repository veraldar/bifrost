/** Stall watchdog for opencode runs (user req 09-26: a hung provider stream
 *  wedged the UX session for 2h — POST /message never resolved, so no
 *  markRunEnd, the proxy queue stalled, and opencode logged nothing).
 *
 *  Signal: opencode's /event SSE fires constantly while a run is alive
 *  (stream deltas, tool parts, step messages). A live run with ZERO events
 *  for STALL_MS is wedged — nothing else detects that shape: a working run
 *  can't stay silent, and the messages-route zombie heal only proves a run
 *  ENDED, not that it hung. Remedy: POST /session/:id/abort, which resolves
 *  the in-flight forward() fetch → its .finally does markRunEnd + queue
 *  pickup (existing machinery). If the owning fetch is gone (proxy restart
 *  orphan), runEnded() is the fallback after a grace wait.
 *
 *  Aborts only fire while the SSE is connected — a proxy-side stream outage
 *  must not kill healthy runs. Every scan over live runs, every abort and
 *  every reconnect lands in .diag/diag-<day>.log (kind=watchdog) so the next
 *  diagnosis reads one file instead of diffing opencode timestamps. */
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { get } from 'node:http';
import { OC, ocFetch } from './oc';
import { liveSids, liveSince } from './oc-live';
import { runEnded } from './oc-forward';
import { emitRunDone, emitRunError } from './run-events';
import { bustCache } from './oc-cache';

/** 10min, not less: opencode emits NO events during a long silent tool call
 *  (verified: `sleep 45` shows quiet growing to ~30s+), so renders/builds
 *  look like stalls. 10min tolerates those; the real 2h hang this guards
 *  against was silent from its first second. Env-tunable for tuning. */
const STALL_MS = Number(process.env.OC_STALL_MS) || 10 * 60_000;
const SCAN_MS = 30_000;
const DIR = path.join(process.cwd(), '.diag');
// Watchdog-graph start (≈ proxy boot). Runs known only through opencode's
// own busy map (agent/voice initiated — the proxy tracker never sees them)
// have no start timestamp, so their quiet clock measures from here: one full
// stall window of grace after boot before any verdict on an unknown run.
const bootedAt = Date.now();
// sid → epoch ms of the last stall abort. opencode's /session/status busy
// flag is STICKY after a hung run (verified 10-01: ses_f269378… still busy
// since 09-29, zero events for 2 days) — without this guard every 30s scan
// would re-abort the same dead session forever and re-push the phone error.
// A NEW stall re-arms: fresh stream evidence (lastEvent) after the abort
// clears the block.
const lastStallAbort = new Map<string, number>();

// sid → epoch ms of last SSE event. On globalThis: Next 15 gives each route
// its own module graph, and the messages route reads this as X-Run-Last-Event
// — the client's wedge escape must see the SAME quiet evidence the scan uses.
const gW = globalThis as unknown as { __ozLastEvent?: Map<string, number> };
const lastEvent: Map<string, number> = (gW.__ozLastEvent ??= new Map());
/** Epoch ms of the last opencode stream event for a session (0 = none seen).
 *  Covers proxy AND agent runs — the stream sees everything opencode does. */
export const lastEventAt = (sid: string) => lastEvent.get(sid) || 0;
let started = false;
let connected = false;
let downSince = 0;
let warnedDown = false;

async function diag(msg: string) {
  const line = `${new Date().toISOString()} [watchdog] (proxy · server) ${msg}`;
  console.log(line);
  try {
    await mkdir(DIR, { recursive: true });
    await appendFile(
      path.join(DIR, `diag-${new Date().toISOString().slice(0, 10)}.log`),
      line + '\n'
    );
  } catch {
    /* diag is best-effort */
  }
}

/** Abort one wedged run and do the end-of-run bookkeeping that its owner
 *  can no longer do. Shared by both scan sources (proxy-tracked and
 *  opencode-busy) so neither can double-abort the same stall. */
async function stallAbort(sid: string, quietS: number, why: string) {
  void diag(`STALL ${sid}: no events for ${quietS}s (${why}) — aborting wedged run`);
  // the phone learns immediately instead of waiting for its poll heuristics
  // to notice (2026-09-30: a dead run masked as |0|assistant for 15 min)
  emitRunError(sid, `run stalled — no activity for ${quietS}s, auto-stopped`);
  try {
    await ocFetch(`/session/${sid}/abort`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    // only a DELIVERED abort blocks re-aborts — a failed one retries next
    // scan (opencode half-down must not disarm the remedy)
    lastStallAbort.set(sid, Date.now());
  } catch (e) {
    void diag(`abort fetch failed for ${sid}: ${e}`);
  }
  // the in-flight forward()'s .finally normally does end-of-run bookkeeping
  // on abort; if the owning fetch is gone (restart orphan) nothing will —
  // clean up ourselves after a grace wait (slug fallback: push target is
  // wrong on this path, but a restart-orphaned run has no listener anyway)
  setTimeout(() => {
    if (liveSince(sid)) {
      void diag(`run ${sid} still flagged live after abort — orphaned entry, cleaning up`);
      runEnded(sid, sid);
    }
  }, 10_000);
}

async function stallScan() {
  // stream outage: no verdicts possible — one warning per outage, then
  // reconnect logic owns it
  const tracked = liveSids();
  if (!connected) {
    if (!warnedDown && downSince && tracked.length && Date.now() - downSince > 60_000) {
      warnedDown = true;
      void diag(
        `stream down ${Math.round((Date.now() - downSince) / 1000)}s with live runs: ${tracked.join(' ')} — aborts paused`
      );
    }
    return;
  }
  // opencode's own busy map is the SECOND scan source: it reports every run
  // IT is still working on — including agent/voice turns posted straight to
  // opencode, which the proxy run tracker never sees. 2026-10-01 15:17 "no
  // reply": an agent run hung 09-30 21:08 with zero stream events; blocked
  // the session for 18h; both later prompts (11:34 proxy, 15:14 agent)
  // serialized behind the zombie and were silently swallowed. liveSids()
  // alone is blind to exactly that shape. A failed status fetch just
  // degrades this cycle to tracked runs only.
  let busy: Record<string, unknown> = {};
  try {
    busy = (await ocFetch('/session/status')) as Record<string, unknown>;
  } catch {
    busy = {};
  }
  const all = new Set([...tracked, ...Object.keys(busy)]);
  const now = Date.now();
  for (const sid of all) {
    const isTracked = tracked.includes(sid);
    const runStart = liveSince(sid) || 0;
    const lastEv = lastEvent.get(sid) || 0;
    const quietFor = now - Math.max(lastEv, runStart || bootedAt);
    // sticky-busy guard FIRST: a session already stall-aborted stays silent
    // (no log, no abort) until fresh stream evidence arrives — a new run
    // that hangs again re-arms it
    if ((lastStallAbort.get(sid) || 0) >= Math.max(lastEv, 1)) continue;
    // tracked runs: full per-scan trail (existing behavior). Status-only
    // runs: log from half-stall on — sticky-busy zombies would otherwise
    // spam one line every 30s for days
    if (isTracked || quietFor > STALL_MS / 2) {
      void diag(
        `scan ${sid}${isTracked ? '' : ' (opencode-busy, untracked)'} live ` +
          `${Math.round((now - (runStart || bootedAt)) / 1000)}s, quiet ` +
          `${Math.round(quietFor / 1000)}s (stall limit ${STALL_MS / 1000}s)`
      );
    }
    if (quietFor <= STALL_MS) continue;
    await stallAbort(
      sid,
      Math.round(quietFor / 1000),
      isTracked ? 'tracked run' : 'opencode-busy, untracked (agent/voice run)'
    );
  }
}

/** One SSE connection via raw node:http — Next patches global fetch (cache/
 *  ISR wrappers) and its buffering ate stream events in live testing (a run
 *  showed zero captured events while curl -N on the same endpoint saw them),
 *  which would silence the watchdog exactly when it's needed. */
function connect() {
  const req = get(
    `${OC}/event`,
    { headers: { Accept: 'text/event-stream' } },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`event stream ${res.statusCode}`));
        return;
      }
      connected = true;
      downSince = 0;
      warnedDown = false;
      void diag('event stream connected — stall watchdog active');
      const dec = new TextDecoder();
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += dec.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // regex the raw block instead of JSON.parse: version-proof against
          // event envelope changes, and cheap at stream volume
          const m = /"sessionID":"(ses_[A-Za-z0-9]+)"/.exec(block);
          if (m) {
            lastEvent.set(m[1], Date.now());
            // the home list shows the per-session working dot from a 60s
            // server cache — but voice runs (agent → opencode directly) and
            // external clients never touch the proxy's run tracker, so the
            // dot lagged up to a minute behind a live run (live 2026-09-29:
            // "new test" worked for minutes with a stale idle list). Any
            // stream activity for a session invalidates the cache; the
            // list's next poll (≤8s) recomputes fresh. Throttled: streams
            // fire per token-delta batch — one bust per 5s is plenty.
            const nowMs = Date.now();
            const gb = globalThis as unknown as { __ozListBustAt?: number };
            if (nowMs - (gb.__ozListBustAt || 0) > 5_000) {
              gb.__ozListBustAt = nowMs;
              bustCache();
            }
            // completion signal for the run-events fanout. session.idle is
            // the WHOLE run finishing (all steps) — the hands-free
            // auto-listen may only speak on it. A message.updated with a set
            // time.completed also fires at EVERY step end of a multi-step
            // run: that is a 'step' refresh signal, never a speak trigger
            // (req 09-28: speaking per step restarted the audio mid-answer).
            const idle = /session\.idle/.test(block);
            if (idle || /"completed":\s*1\d{12}/.test(block)) {
              emitRunDone(m[1], idle ? 'idle' : 'step');
            }
          }
        }
      });
      res.on('end', () => fail(new Error('stream ended')));
      res.on('error', fail);
    }
  );
  const fail = (e: Error) => {
    if (connected) void diag(`event stream lost: ${e.message}`);
    connected = false;
    if (!downSince) downSince = Date.now();
    req.destroy();
  };
  req.on('error', fail);
}

/** Idempotent ACROSS route module graphs: Next 15 bundles each handler
 *  export as its own module graph, so the module-level `started` flag alone
 *  would let GET + POST + SSE routes each run a private watchdog (duplicate
 *  streams, double aborts). The cross-graph flag lives on globalThis. */
export function ensureWatchdog() {
  const g = globalThis as unknown as { __ozWatchdogArmed?: boolean };
  if (g.__ozWatchdogArmed) return;
  g.__ozWatchdogArmed = true;
  if (started) return;
  started = true;
  void diag(`watchdog armed (stall limit ${STALL_MS / 1000}s, opencode ${OC})`);
  // supervisor: whenever the stream is down, reconnect within 2s; while it's
  // up, no-op (so connections never stack)
  (function supervise() {
    if (!connected) {
      try {
        connect();
      } catch (e) {
        void diag(`event stream connect threw: ${e}`);
      }
    }
    setTimeout(supervise, 2000).unref?.();
  })();
  setInterval(stallScan, SCAN_MS).unref?.();
}

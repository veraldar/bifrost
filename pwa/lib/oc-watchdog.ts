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

/** 10min, not less: opencode emits NO events during a long silent tool call
 *  (verified: `sleep 45` shows quiet growing to ~30s+), so renders/builds
 *  look like stalls. 10min tolerates those; the real 2h hang this guards
 *  against was silent from its first second. Env-tunable for tuning. */
const STALL_MS = Number(process.env.OC_STALL_MS) || 10 * 60_000;
const SCAN_MS = 30_000;
const DIR = path.join(process.cwd(), '.diag');

const lastEvent = new Map<string, number>(); // sid → epoch ms of last SSE event
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

async function stallScan() {
  const sids = liveSids();
  if (!sids.length) return;
  if (!connected) {
    // stream outage: no verdicts possible — one warning per outage, then
    // reconnect logic owns it
    if (!warnedDown && downSince && Date.now() - downSince > 60_000) {
      warnedDown = true;
      void diag(
        `stream down ${Math.round((Date.now() - downSince) / 1000)}s with live runs: ${sids.join(' ')} — aborts paused`
      );
    }
    return;
  }
  const now = Date.now();
  for (const sid of sids) {
    const runStart = liveSince(sid) || 0;
    const lastEv = lastEvent.get(sid) || 0;
    const quietFor = now - Math.max(lastEv, runStart);
    void diag(
      `scan ${sid} live ${Math.round((now - runStart) / 1000)}s, quiet ${Math.round(quietFor / 1000)}s (stall limit ${STALL_MS / 1000}s)`
    );
    if (quietFor <= STALL_MS) continue;
    void diag(`STALL ${sid}: no events for ${Math.round(quietFor / 1000)}s — aborting wedged run`);
    try {
      await ocFetch(`/session/${sid}/abort`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
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
          if (m) lastEvent.set(m[1], Date.now());
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

/** Idempotent: starts the SSE listener + stall scanner once per process.
 *  Called from the messages route (every send/poll re-arms it). */
export function ensureWatchdog() {
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

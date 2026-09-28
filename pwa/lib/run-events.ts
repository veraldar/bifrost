/** In-process run-completion fanout. The watchdog's opencode SSE sees every
 *  run finish (session.idle / a message.updated with time.completed set);
 *  HTTP handlers subscribe here to push "run done" to connected phone pages.
 *
 *  Next 15 bundles each route as its own module graph — a plain module-level
 *  Set would give every route its own disconnected registry. The subscriber
 *  set lives on globalThis so the watchdog's emits reach the SSE route. */
/** Why a run signal fired:
 *  - 'idle'  — opencode session.idle: the WHOLE run finished (all steps);
 *              the only signal the hands-free auto-listen may speak on.
 *  - 'step'  — one assistant step message completed mid-run. Refresh-only:
 *              speaking here restarts the deck on every step of a multi-step
 *              run (req 09-28: audio restarted from the start 10-20s in). */
export type RunDoneReason = 'idle' | 'step';
type Cb = (sid: string, reason: RunDoneReason) => void;

const g = globalThis as unknown as { __ozRunDoneSubs?: Set<Cb> };
const subs: Set<Cb> = (g.__ozRunDoneSubs ??= new Set<Cb>());

export function onRunDone(cb: Cb): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

export function emitRunDone(sid: string, reason: RunDoneReason): void {
  for (const cb of subs) {
    try {
      cb(sid, reason);
    } catch {
      /* a dead subscriber must not kill the event stream */
    }
  }
}

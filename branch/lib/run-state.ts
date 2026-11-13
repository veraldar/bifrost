/** Herdr §1.1 fold: the working/blocked/idle TRIAD as harness-owned state.
 *  The busy map was binary (busy/idle); herdr proves the third state is the
 *  coordination feature users feel: "never hunt for the stuck one — when an
 *  agent stops and needs an answer, herdr says so."
 *
 *  Authority layering (herdr §1.2): DECLARED over detected, never the other
 *  way round.
 *   1. the brain's declaration — yggdrasil's run loop declares every
 *      session's state itself (`state` on each session info: working,
 *      blocked + reason error | step-cap | interrupted, idle);
 *   2. the proxy's own in-flight record (lib/oc-live) — a forward the brain
 *      has not started yet is still working;
 *   3. only for a brain that declares nothing (opencode): the cheap detector
 *      — a run the transcript says is awaited, with nothing in flight and
 *      the event stream quiet past the stall window, is blocked (the corpse
 *      shape the wedge guard aborts, surfaced as a state).
 *
 *  The deck chips ride the NEXT build; this build ships the truth on the
 *  wire (list route `state` / `stateReason` / `stateSource`). */

export type RunState = 'working' | 'blocked' | 'idle';

/** What the brain declared for a session (yggdrasil `info.state`), if anything. */
export type Declared = { type?: string; reason?: string } | null | undefined;

export type Resolved = {
  state: RunState;
  reason?: string;
  source: 'brain' | 'proxy' | 'detector';
};

/** Detector fallback only: awaited + silent past the stall window = blocked. */
export function detect(awaited: boolean, lastEventAt: number, stallMs: number): RunState {
  return awaited && Date.now() - lastEventAt > stallMs ? 'blocked' : 'idle';
}

/** @param declared the brain's own state for the session (undefined = the
 *  brain declares none) · @param proxyLive the proxy tracks a run in flight
 *  for it right now · @param awaited transcript evidence a run is awaited
 *  (last relevant step un-completed, inside the pending TTL) ·
 *  @param lastEventAt epoch ms of the session's last brain stream event
 *  (0 = none ever) · @param stallMs quiet window before "awaited + silent"
 *  reads stuck */
export function runState(
  declared: Declared,
  proxyLive: boolean,
  awaited: boolean,
  lastEventAt: number,
  stallMs: number
): Resolved {
  const d = declared?.type;
  if (d === 'working') return { state: 'working', source: 'brain' };
  if (proxyLive) return { state: 'working', source: 'proxy' };
  if (d === 'blocked') return { state: 'blocked', reason: declared?.reason, source: 'brain' };
  if (d === 'idle') return { state: 'idle', source: 'brain' };
  const state = detect(awaited, lastEventAt, stallMs);
  return state === 'blocked'
    ? { state, reason: 'stalled', source: 'detector' }
    : { state, source: 'detector' };
}

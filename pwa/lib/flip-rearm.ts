'use client';

/**
 * flip-rearm (ops/flip-automation, req 10-03): the phone never needs manual
 * action across an invisible version flip.
 *
 * A flip restarts the proxy (and the voice agent) under a live hands-free
 * client. M0 (e2e/flip.spec.ts, commit 46acf1e) pinned what that demanded
 * of the phone BEFORE this file existed: a silent down-window, and after a
 * mid-flip reload an agent-less room that faked "listening" forever — a
 * manual tap was the only way back.
 *
 * This hook is the contract that replaces the manual step:
 *  - while the server is down: a visible note + bounded retry (the poller
 *    keeps polling; the bound is the loudness deadline, not a give-up)
 *  - on return / agent return: re-arm hands-free automatically — fresh
 *    token mint re-dispatches the agent (token route dispatches per mint),
 *    mic goes hot, cycle back to listening. No tap.
 *  - if the bound is exceeded: a LOUD note (and a notification when the
 *    user granted permission) — retries continue quietly past it, because
 *    "server came back later" must still heal itself.
 *
 * The voice work itself lives in the page (room/mic ownership); this file
 * owns only the clock, the notes, and the loudness.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { diagEvent } from '@/lib/diag';

/** Default loudness deadline: the flip script's window must end inside
 *  this. Override for tests via localStorage 'oz-flip-bound-ms'. */
const DEFAULT_BOUND_MS = 8 * 60_000;
/** One re-arm attempt every 10s: fresh mint → dispatch → agent join. */
const ATTEMPT_MS = 10_000;
/** A restarted lk-agent may rejoin on its own (agent-dup fix) — never race
 *  a joining agent; the re-arm only fires once the room stayed empty. */
const AGENT_GRACE_MS = 6_000;
/** agentLost debounces itself — one re-arm loop per 30s, max. */
const AGENT_LOST_DEBOUNCE_MS = 30_000;

export type FlipRearm = {
  /** Rendered banner text ('' = nothing). data-testid="flip-note". */
  note: string;
  /** True while the server is unreachable. */
  down: boolean;
  /** A poll failed — first call opens the bounded down-window. */
  noteFail: () => void;
  /** A poll succeeded — closes the window, kicks the re-arm on return. */
  noteOk: () => void;
  /** The room's last agent left (lk-agent restarted mid-hands-free). */
  agentLost: () => void;
  /** A reload-restore landed connected but agent-less. */
  restoreAgentless: () => void;
  /** User left hands-free / session — drop everything quietly. */
  clear: () => void;
};

export function useFlipRearm(opts: {
  slug: string;
  /** true while the user is IN hands-free — re-arm is a hands-free duty */
  active: boolean;
  /** One attempt: fresh mint + bounded agent wait. Resolves true when the
   *  agent is present (or hands-free is moot); false = still agent-less. */
  attempt: () => Promise<boolean>;
}): FlipRearm {
  const { slug, active, attempt } = opts;
  const [note, setNote] = useState('');
  const [down, setDown] = useState(false);

  const downAtRef = useRef(0);
  const boundRef = useRef(DEFAULT_BOUND_MS);
  const boundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const escalatedRef = useRef(false);
  const lastAgentLostRef = useRef(0);
  const runningRef = useRef(false);
  const transientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef({ slug, active, attempt });
  optsRef.current = { slug, active, attempt };

  useEffect(() => {
    try {
      const o = Number(localStorage.getItem('oz-flip-bound-ms'));
      if (o > 0) boundRef.current = o;
    } catch {
      /* private mode */
    }
    return () => {
      if (boundTimerRef.current) clearTimeout(boundTimerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
    };
  }, []);

  const loud = useCallback((msg: string) => {
    diagEvent('flip', `LOUD: ${msg}`);
    setNote(`⚠ ${msg}`);
    // in-page notifications can't fire on a frozen Android tab — but the
    // proxy pushes on completion too; this is the same best-effort pattern
    // as lib/notify.ts notifyReply (graceful no-op without permission)
    void (async () => {
      try {
        if (typeof window === 'undefined' || !('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        const reg = await navigator.serviceWorker?.getRegistration();
        const options = {
          body: msg,
          tag: 'oz-flip',
          icon: '/favicon.ico',
          data: { slug: optsRef.current.slug },
        };
        if (reg) await reg.showNotification('bifrost', options);
        else new Notification('bifrost', options);
      } catch {
        /* notifications unavailable — the banner is the loudness */
      }
    })();
  }, []);

  /** The bounded re-arm loop: attempt → (agent present? done) → wait →
   *  again, escalating ONCE at the bound, retrying quietly past it. */
  const runAttempts = useCallback(async (why: string) => {
    const { active: act, slug: s } = optsRef.current;
    if (!act || runningRef.current) return;
    runningRef.current = true;
    // the loudness clock starts ONCE per down/agentless episode — per-iteration
    // re-reading (downAt || now) would reset it every attempt and never fire
    const startedAt = downAtRef.current || Date.now();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!optsRef.current.active) return; // user left hands-free mid-loop
        attemptsRef.current += 1;
        const n = attemptsRef.current;
        if (!escalatedRef.current) setNote(`server changed — re-arming hands-free (${n})`);
        diagEvent('flip', `re-arm attempt ${n} (${why})`);
        const ok = await optsRef.current.attempt();
        if (ok) {
          attemptsRef.current = 0;
          escalatedRef.current = false;
          if (boundTimerRef.current) clearTimeout(boundTimerRef.current);
          boundTimerRef.current = null;
          diagEvent('flip', `re-arm OK after ${n} attempt(s)`);
          if (n > 1 || downAtRef.current) {
            setNote('hands-free re-armed');
            if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
            transientTimerRef.current = setTimeout(() => setNote(''), 5_000);
          } else {
            setNote('');
          }
          return;
        }
        const elapsed = Date.now() - startedAt;
        if (!escalatedRef.current && elapsed >= boundRef.current) {
          escalatedRef.current = true;
          loud(
            `flip window exceeded (${Math.round(elapsed / 1000)}s) — the server ` +
              `never came back with its voice agent. Still retrying; tap the mic ` +
              `only if this stays stuck.`
          );
        }
        await new Promise((r) => {
          retryTimerRef.current = setTimeout(r, ATTEMPT_MS);
        });
      }
    } finally {
      runningRef.current = false;
    }
  }, [loud]);

  const noteFail = useCallback(() => {
    if (downAtRef.current) return; // window already open
    downAtRef.current = Date.now();
    setDown(true);
    diagEvent('flip', `server down — bounded retry opens (${optsRef.current.slug})`);
    if (!escalatedRef.current) setNote('server down — retrying…');
    if (boundTimerRef.current) clearTimeout(boundTimerRef.current);
    boundTimerRef.current = setTimeout(() => {
      const elapsed = Date.now() - downAtRef.current;
      escalatedRef.current = true;
      loud(
        `server down ${Math.round(elapsed / 1000)}s — longer than the flip ` +
          `window. Still retrying; hands-free re-arms on return.`
      );
    }, boundRef.current);
  }, [loud]);

  const noteOk = useCallback(() => {
    if (!downAtRef.current) return; // was never down
    const secs = Math.round((Date.now() - downAtRef.current) / 1000);
    downAtRef.current = 0;
    setDown(false);
    if (boundTimerRef.current) clearTimeout(boundTimerRef.current);
    boundTimerRef.current = null;
    diagEvent('flip', `server back after ${secs}s`);
    void runAttempts('server back');
  }, [runAttempts]);

  const agentLost = useCallback(() => {
    const now = Date.now();
    if (now - lastAgentLostRef.current < AGENT_LOST_DEBOUNCE_MS) return;
    lastAgentLostRef.current = now;
    diagEvent('flip', `agent left the room — grace ${AGENT_GRACE_MS / 1000}s, then re-arm`);
    setTimeout(() => {
      if (optsRef.current.active) void runAttempts('agent lost');
    }, AGENT_GRACE_MS);
  }, [runAttempts]);

  const restoreAgentless = useCallback(() => {
    diagEvent('flip', 'reload restored hands-free into an empty room — re-arm');
    void runAttempts('restore agentless');
  }, [runAttempts]);

  const clear = useCallback(() => {
    downAtRef.current = 0;
    attemptsRef.current = 0;
    escalatedRef.current = false;
    if (boundTimerRef.current) clearTimeout(boundTimerRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    boundTimerRef.current = null;
    retryTimerRef.current = null;
    setDown(false);
    setNote('');
  }, []);

  // leaving hands-free resets the whole machine
  useEffect(() => {
    if (!active) clear();
  }, [active, clear]);

  return { note, down, noteFail, noteOk, agentLost, restoreAgentless, clear };
}

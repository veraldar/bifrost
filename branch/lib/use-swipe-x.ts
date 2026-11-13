'use client';

import { useEffect, useRef, useState } from 'react';

/** Horizontal swipe detection that wins the race against native scrolling.
 *
 *  Pointer events alone lose on touch: the browser claims a drift-y gesture
 *  for vertical scrolling and fires pointercancel before the swipe commits
 *  (2026-09-28: worked in the mouse-driven e2e, dead on the phone). The fix
 *  is a non-passive touchmove listener — React registers touchmove passive
 *  at the root, so preventDefault must be wired manually — that fires the
 *  moment the gesture is horizontal-dominant, canceling native scroll for
 *  the whole gesture so it can finish as a swipe. Mouse input (desktop +
 *  e2e) rides regular pointer events with pointer capture. */
export function useSwipeX<T extends HTMLElement = HTMLElement>(opts: {
  /** committed horizontal travel that fires onCommit (default 48) */
  threshold?: number;
  /** live drag feedback; null = gesture ended or abandoned */
  onMove?: (dx: number | null) => void;
  onCommit: (dir: 'older' | 'newer') => void;
  /** return true to not start a swipe from this target (e.g. a lightbox) */
  ignoreStart?: (target: EventTarget | null) => boolean;
  /** touch gestures only — skip the mouse/pointer path (a mouse-drag must
   *  stay text selection on inputs; PC recall uses arrow keys there) */
  touchOnly?: boolean;
}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // callback ref (not a ref object): elements swap at runtime — the composer
  // textarea remounts when the PTT pill takes over — so listeners must
  // re-attach on every mount, not just the first
  const [el, setEl] = useState<T | null>(null);

  useEffect(() => {
    if (!el) return;
    // gesture scratch: on + origin + decision ('' undecided, 'h' ours, 'v' scroll's)
    const g = { on: false, x0: 0, y0: 0, mode: '' as '' | 'h' | 'v' };
    let dx = 0;

    const reset = () => {
      if (g.on && g.mode === 'h') optsRef.current.onMove?.(null);
      g.on = false;
      g.mode = '';
    };
    /** returns true when the move belongs to a horizontal swipe */
    const move = (x: number, y: number): boolean => {
      if (!g.on) return false;
      const mx = x - g.x0;
      const my = y - g.y0;
      if (!g.mode) {
        // decide early (before the browser's scroll slop) — this is the race
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return false;
        g.mode = Math.abs(mx) > Math.abs(my) ? 'h' : 'v';
      }
      if (g.mode === 'v') return false;
      dx = mx;
      optsRef.current.onMove?.(mx);
      return true;
    };
    const end = (x: number) => {
      if (!g.on) return;
      const committed = g.mode === 'h' && Math.abs(x - g.x0) >= (optsRef.current.threshold ?? 48);
      const dir = x >= g.x0 ? 'older' : 'newer';
      reset();
      if (committed) optsRef.current.onCommit(dir);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return reset();
      if (optsRef.current.ignoreStart?.(e.target)) return;
      g.on = true;
      g.mode = '';
      g.x0 = e.touches[0].clientX;
      g.y0 = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (move(t.clientX, t.clientY)) e.preventDefault(); // scroll never claims it
    };
    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (t) end(t.clientX);
    };
    const onMouseDown = (e: PointerEvent) => {
      if (optsRef.current.touchOnly) return;
      if (e.pointerType !== 'mouse' || !e.isPrimary) return;
      if (optsRef.current.ignoreStart?.(e.target)) return;
      g.on = true;
      g.mode = '';
      g.x0 = e.clientX;
      g.y0 = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const onMouseMove = (e: PointerEvent) => {
      if (g.on) move(e.clientX, e.clientY);
    };
    const onMouseUp = (e: PointerEvent) => {
      if (g.on) end(e.clientX);
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', reset);
    el.addEventListener('pointerdown', onMouseDown);
    el.addEventListener('pointermove', onMouseMove);
    el.addEventListener('pointerup', onMouseUp);
    el.addEventListener('pointercancel', reset);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', reset);
      el.removeEventListener('pointerdown', onMouseDown);
      el.removeEventListener('pointermove', onMouseMove);
      el.removeEventListener('pointerup', onMouseUp);
      el.removeEventListener('pointercancel', reset);
    };
  }, [el]);

  return setEl;
}


'use client';

import { useEffect, useState } from 'react';
import { LineIcon } from '@/components/line-icon';
import { type Msg, SessionMessage } from '@/components/session-message';
import { useSwipeX } from '@/lib/use-swipe-x';

const STEP_PX = 64;

/** Full-screen message history browser, one message at a time. Swipe
 *  left→right steps into the past, right→left back toward the present, and
 *  swiping left past the newest message closes ("back to no message").
 *  Vertical scrolls inside a tall message still work (the swipe hook only
 *  claims horizontal-dominant gestures). */
export function MessageHistory({
  msgs,
  index,
  onIndex,
  onClose,
}: {
  msgs: Msg[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const i = Math.min(Math.max(index, 0), msgs.length - 1);
  const m = msgs[i];
  const [dx, setDx] = useState(0);
  const atStart = i === 0;
  const atEnd = i === msgs.length - 1;
  const cardRef = useSwipeX<HTMLDivElement>({
    threshold: STEP_PX,
    onMove: (d) => setDx(d ?? 0),
    onCommit: (dir) => {
      if (dir === 'older') {
        if (!atStart) onIndex(i - 1);
      } else if (atEnd) onClose();
      else onIndex(i + 1);
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!m) return null;
  // rubber-band where there is no next message: 3:1 over-drag resistance
  const shown = dx > 0 && atStart ? dx / 3 : dx;
  const hint =
    dx > 8 ? (atStart ? '· start of session' : '· ← older') : dx < -8 ? (atEnd ? '· release to close' : '· newer →') : '';

  return (
    <div
      role="dialog"
      aria-label="message history"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex flex-col px-3 pt-2"
      style={{ background: 'color-mix(in srgb, var(--oz-bg) 94%, transparent)' }}
    >
      <div className="flex items-center justify-between pb-2 text-[11px] text-[var(--oz-dim)]">
        <span className="tabular-nums">
          {i + 1} / {msgs.length} {hint}
        </span>
        <button aria-label="close history" onClick={onClose} className="oz-k sm">
          <LineIcon name="close" size={13} />
        </button>
      </div>
      <div
        ref={cardRef}
        data-testid="hist-card"
        style={{
          transform: `translateX(${shown}px)`,
          transition: dx ? 'none' : 'transform 160ms ease-out',
          touchAction: 'pan-y',
        }}
        className="oz-box min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"
      >
        <SessionMessage m={m} mi={i} />
      </div>
      <div className="py-2 text-center text-[10px] text-[var(--oz-dim)]">
        swipe → older · ← newer · past the last message closes
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { PixelIcon } from '@/components/pixel-icon';
import { type Msg, SessionMessage } from '@/components/session-message';

const STEP_PX = 72;

/** Full-screen message history browser, one message at a time. Swipe
 *  left→right steps into the past, right→left back toward the present, and
 *  swiping left past the newest message closes ("back to no message").
 *  Vertical scrolls inside a tall message still work natively (pan-y). */
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
  const [dragging, setDragging] = useState(false);
  const x0 = useRef(0);
  const y0 = useRef(0);
  // null = still deciding; once true the drag is ours (horizontal), once
  // false the browser owns it (vertical scroll) and we never step in
  const horiz = useRef<boolean | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!m) return null;
  const atStart = i === 0;
  const atEnd = i === msgs.length - 1;
  // over-drag resistance: 3:1 rubber-band where there is no next message
  const peek = (d: number) => (d > 0 && atStart ? d / 3 : d);
  const hint = !dragging
    ? ''
    : dx > 8
      ? atStart
        ? '· start of session'
        : '· ← older'
      : dx < -8
        ? atEnd
          ? '· release to close'
          : '· newer →'
        : '';

  const commit = () => {
    if (dx > STEP_PX && !atStart) onIndex(i - 1);
    else if (dx < -STEP_PX) {
      if (atEnd) onClose();
      else onIndex(i + 1);
    }
    setDx(0);
    setDragging(false);
  };

  return (
    <div
      role="dialog"
      aria-label="message history"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 px-3 pt-2 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between pb-2 text-[11px] text-[var(--oz-dim)]">
        <span className="tabular-nums">
          {i + 1} / {msgs.length} {hint}
        </span>
        <button aria-label="close history" onClick={onClose} className="p-1">
          <PixelIcon name="close" size={14} />
        </button>
      </div>
      <div
        data-testid="hist-card"
        onPointerDown={(e) => {
          if (!e.isPrimary) return;
          x0.current = e.clientX;
          y0.current = e.clientY;
          horiz.current = null;
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragging || horiz.current === false) return;
          const mx = e.clientX - x0.current;
          const my = e.clientY - y0.current;
          if (horiz.current === null) {
            if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
            horiz.current = Math.abs(mx) > Math.abs(my);
            if (!horiz.current) return;
          }
          setDx(peek(mx));
        }}
        onPointerUp={commit}
        onPointerCancel={() => {
          setDx(0);
          setDragging(false);
        }}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 160ms ease-out',
          touchAction: 'pan-y',
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded border border-[var(--oz-border)] bg-[var(--oz-surface)] p-3"
      >
        <SessionMessage m={m} mi={i} />
      </div>
      <div className="py-2 text-center text-[10px] text-[var(--oz-dim)]">
        swipe → older · ← newer · past the last message closes
      </div>
    </div>
  );
}

'use client';

/** Tree-first (lib/tree-first.ts): the tree is the first thing a device ever
 *  sees, and afterwards the way back to THE MAIN session.
 *    FirstTree  first open — the whole tree, alone, one quiet invitation;
 *               a tap wakes it (one pulse up the trunk) and starts the
 *               hands-free onboarding
 *    TreeDoor   afterwards — the same drawing shrunk to its corner, a link
 *               to MAIN; the shrink from full screen plays once */
import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { YggTree } from '@/components/ygg';
import { MAIN_SLUG, TF_SHRINK_KEY } from '@/lib/tree-first';

/** `onStart` opens the onboarding session and returns where it lives. */
export function FirstTree({ onStart }: { onStart: () => Promise<string> }) {
  const router = useRouter();
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState('');

  async function wake() {
    if (waking) return;
    setError('');
    setWaking(true);
    try {
      // the pulse is the answer — let it climb before the room changes
      const [href] = await Promise.all([onStart(), new Promise((r) => setTimeout(r, 1200))]);
      router.push(href);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWaking(false);
    }
  }

  return (
    <main className="oz-first">
      <button
        data-testid="tree-first"
        aria-label="set up your box by voice — grants mic access, hands-free, this session"
        aria-busy={waking}
        onClick={() => void wake()}
        className={`oz-ygg ${waking ? 'wake' : ''}`}
      >
        <YggTree slice />
      </button>
      <p className="oz-invite" aria-hidden="true">
        {error ? (
          <span className="err">your box did not answer — {error}. tap to try again</span>
        ) : (
          <>
            <span>tap the tree — set up your box by voice</span>
            <span className="sub">grants mic access · hands-free · this session</span>
          </>
        )}
      </p>
    </main>
  );
}

export function TreeDoor() {
  const ref = useRef<HTMLAnchorElement>(null);
  // the one-shot is consumed before paint: the door starts at full screen
  // and settles into its corner — or simply stands there, every later time
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let play = false;
    try {
      play = sessionStorage.getItem(TF_SHRINK_KEY) !== null;
      sessionStorage.removeItem(TF_SHRINK_KEY);
    } catch {
      /* private mode — the door just stands */
    }
    if (!play) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // same crop both ends (slice, centered): scaled to cover the viewport,
    // the square door frames exactly what the full-screen tree showed
    el.style.setProperty('--tf-s', String(Math.max(vw, vh) / r.width));
    el.style.setProperty('--tf-x', `${vw / 2 - (r.left + r.width / 2)}px`);
    el.style.setProperty('--tf-y', `${vh / 2 - (r.top + r.height / 2)}px`);
    el.classList.add('shrink');
  }, []);

  return (
    <Link
      ref={ref}
      href={`/session/${MAIN_SLUG}`}
      data-testid="tree-door"
      aria-label="open MAIN"
      className="oz-door oz-ygg"
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.remove('shrink');
      }}
    >
      <YggTree slice />
    </Link>
  );
}

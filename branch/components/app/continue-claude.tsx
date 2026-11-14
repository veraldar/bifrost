'use client';

/** "Continue a Claude Code session" (11-13): the owner's own Claude Code conversations on this
 *  box (newest first, from the brain), one tap → an [AGI] session that carries on with its full
 *  context. The brain forks it on the first turn — the terminal's transcript is never written —
 *  and keeps Claude Code's permission guard on. */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { slugify } from '@/lib/slug';

type CcSession = { id: string; cwd: string; modified: number; title: string };

const when = (t: number) => {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function ContinueClaude({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [list, setList] = useState<CcSession[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    fetch('/api/harness/claude/sessions', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => (Array.isArray(d) ? setList(d) : setErr(d.error || 'could not list')))
      .catch((e) => setErr(String(e)));
  }, []);

  async function attach(s: CcSession) {
    setBusy(s.id);
    setErr('');
    try {
      const r = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attach: { id: s.id, cwd: s.cwd } }),
      });
      const d = await r.json();
      if (!r.ok || !d.id) throw new Error(d.error || `HTTP ${r.status}`);
      router.push(`/session/${slugify(d.title)}?id=${d.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy('');
    }
  }

  return (
    <div className="oz-box mb-2 p-2" data-testid="continue-claude">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[12px]">continue a Claude Code session</span>
        <button onClick={onClose} className="oz-k sm">
          cancel
        </button>
      </div>
      {err && (
        <p role="alert" className="px-1 pb-1.5 text-[11px] text-[var(--oz-danger)]">
          {err}
        </p>
      )}
      {!list && !err && <p className="px-1 py-2 text-[11px] text-[var(--oz-dim)]">loading…</p>}
      {list && list.length === 0 && (
        <p className="px-1 py-2 text-[11px] text-[var(--oz-dim)]">no Claude Code sessions on this box</p>
      )}
      <ul className="flex max-h-[55dvh] flex-col gap-1 overflow-y-auto">
        {(list || []).map((s) => (
          <li key={s.id}>
            <button
              onClick={() => attach(s)}
              disabled={!!busy}
              data-cc={s.id}
              className="oz-row disabled:opacity-60"
            >
              <div className="oz-r1">
                <span className="t">{busy === s.id ? 'opening…' : s.title}</span>
                <time>{when(s.modified)}</time>
              </div>
              <div className="oz-r2">{s.cwd}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

'use client';

/** /join?r=<req> — the owner's phone approves a NEW machine joining this hub's
 *  tree (docs/spec-join.md). The machine shows this URL as a QR plus a code;
 *  the phone shows the same code — compare them, then add or refuse. Needs a
 *  paired device: without one the phone is sent to pair first. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LineIcon } from '@/components/line-icon';

type View = {
  req: string;
  name: string;
  os: string;
  host: string;
  code: string;
  /** the fingerprint of the WireGuard key approving pins (null: an older machine) */
  wg_fp: string | null;
  status: 'pending' | 'approved' | 'refused' | 'expired' | 'delivered';
  expires_at: string;
  root_id: string | null;
};

const SAID: Record<View['status'], string> = {
  pending: '',
  approved: 'added — the machine is collecting its keys',
  delivered: 'added — the machine has its keys',
  refused: 'refused — the machine was told no',
  expired: 'this request expired — run join again on the machine',
};

export default function JoinPage() {
  const [req, setReq] = useState('');
  const [view, setView] = useState<View | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(id: string, retried = false) {
    const r = await fetch(`/api/roots/join/${encodeURIComponent(id)}/view`, { cache: 'no-store' });
    if (r.status === 401) {
      const hint = await r.json().catch(() => ({}));
      if (hint?.reauth === 'refresh' && !retried) {
        const ok = await fetch('/api/pair/refresh', { method: 'POST' }).then((x) => x.ok);
        if (ok) return load(id, true);
      }
      setStatus('this phone is not paired with the box — pair it first');
      location.replace('/pair?unpaired=1');
      return;
    }
    if (!r.ok) {
      setStatus(
        r.status === 404
          ? 'no such join request — run join again on the machine'
          : 'could not load the request'
      );
      return;
    }
    const v = (await r.json()) as View;
    setView(v);
    setStatus(
      v.root_id && v.status !== 'refused' ? `${SAID[v.status]} (as ${v.root_id})` : SAID[v.status]
    );
  }

  useEffect(() => {
    const id = new URLSearchParams(location.search).get('r') || '';
    setReq(id);
    if (id) void load(id);
    else setStatus('no join request in this link — scan the QR on the machine');
    // once, on mount: the request id comes from the URL
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function decide(what: 'approve' | 'refuse') {
    setBusy(true);
    setStatus(what === 'approve' ? 'adding…' : 'refusing…');
    const r = await fetch(`/api/roots/join/${encodeURIComponent(req)}/${what}`, { method: 'POST' });
    const out = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setStatus(out.error || `${what} failed`);
      return;
    }
    await load(req);
  }

  const pending = view?.status === 'pending';

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <Link href="/" className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="text-[13px]">join a machine</span>
      </header>

      {view && (
        <section className="oz-blk">
          <h2>{pending ? 'add this machine to your tree?' : 'join request'}</h2>
          <ul className="oz-kv">
            <li>
              <span>name</span>
              <span data-testid="join-name" className="break-all">
                {view.name}
              </span>
              <span />
            </li>
            <li>
              <span>system</span>
              <span data-testid="join-os">{view.os || '—'}</span>
              <span />
            </li>
            <li>
              <span>host</span>
              <span data-testid="join-host" className="break-all">
                {view.host || '—'}
              </span>
              <span />
            </li>
          </ul>
          <p
            data-testid="join-code"
            className="my-4 text-center font-mono text-3xl tracking-[0.2em]"
            aria-label="comparison code"
          >
            {view.code}
          </p>
          {view.wg_fp && (
            <p className="note text-center">
              tunnel key{' '}
              <span data-testid="join-wg-fp" className="font-mono">
                {view.wg_fp}
              </span>
            </p>
          )}
          {pending && (
            <>
              <p className="note">
                the machine shows a code too. add it only if both codes match — otherwise refuse.
                {view.wg_fp
                  ? ' adding it trusts its tunnel key: the machine prints the same key line.'
                  : ''}{' '}
                expires {new Date(view.expires_at).toLocaleTimeString()}.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  className="oz-k"
                  data-testid="join-approve"
                  disabled={busy}
                  onClick={() => decide('approve')}
                >
                  Add to my tree
                </button>
                <button
                  className="oz-k"
                  data-testid="join-refuse"
                  disabled={busy}
                  onClick={() => decide('refuse')}
                >
                  Refuse
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {status && (
        <section className="oz-blk">
          <p data-testid="join-status" className="note">
            {status}
          </p>
        </section>
      )}
    </main>
  );
}

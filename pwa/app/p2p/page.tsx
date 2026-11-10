'use client';

/** /p2p — the pinned direct transport (v0.9, flagged: Part 15 §b keeps HTTP
 *  the app protocol). Dials the box's bridge with the fingerprint the QR
 *  pinned and runs the app round-trip over the data channel: prompt → the
 *  brain session → run.done → reply. A `severed` notice (revoke, kill-switch,
 *  expired token) ends the link with its reason. The access token is renewed
 *  over the channel before it lapses (auth.refresh) — the bridge drops a peer
 *  whose credential runs out. */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LineIcon } from '@/components/line-icon';
import { BridgeLink, loadPin, type Pin } from '@/lib/p2p';

type Phase = 'idle' | 'connecting' | 'open' | 'severed' | 'error';

async function freshToken(): Promise<{ accessToken: string; expiresIn: number } | null> {
  const r = await fetch('/api/pair/refresh', { method: 'POST' });
  return r.ok ? r.json() : null;
}

export default function P2PPage() {
  const [pin, setPin] = useState<Pin | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [why, setWhy] = useState('');
  const [text, setText] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const link = useRef<BridgeLink | null>(null);
  const waiters = useRef(new Map<string, (n: Record<string, unknown>) => void>());

  useEffect(() => {
    const p = loadPin();
    setPin(p);
    if (!p) {
      setPhase('error');
      setWhy('not paired with a bridge — scan the box QR');
      return;
    }
    void connect(p);
    return () => link.current?.close();
  }, []);

  async function connect(p: Pin) {
    setPhase('connecting');
    const t = await freshToken();
    if (!t) {
      setPhase('error');
      setWhy('this device is not paired anymore — scan a fresh QR');
      return;
    }
    try {
      const l = await BridgeLink.open(p, t.accessToken);
      link.current = l;
      l.onNotice = (n) => {
        if (n.op === 'severed') {
          setPhase('severed');
          setWhy(String(n.why || 'severed'));
          l.close();
        } else if (n.op === 'run.done') {
          waiters.current.get(String(n.id))?.(n);
        }
      };
      l.onClose = (w) => {
        setPhase((cur) => (cur === 'severed' ? cur : 'error'));
        setWhy((cur) => cur || w);
      };
      await l.call('hello');
      setPhase('open');
      renew(l, t.expiresIn);
    } catch (e) {
      setPhase('error');
      setWhy(String((e as Error).message || e));
    }
  }

  // renew a minute before the access token lapses; the bridge rebinds the peer
  function renew(l: BridgeLink, expiresIn: number) {
    setTimeout(async () => {
      if (!l.open) return;
      const t = await freshToken();
      if (!t) return;
      await l.call('auth.refresh', { token: t.accessToken }).catch(() => {});
      renew(l, t.expiresIn);
    }, Math.max(5, expiresIn - 60) * 1000);
  }

  async function send() {
    const l = link.current;
    if (!l || !text.trim()) return;
    setBusy(true);
    setReply('');
    try {
      const sid = new URLSearchParams(location.search).get('session') || 'main';
      const accepted = await l.call('prompt', { id: sid, text });
      const done = await new Promise<Record<string, unknown>>((res, rej) => {
        const t = setTimeout(() => rej(new Error('no run.done in 180s')), 180_000);
        waiters.current.set(String(accepted.id), (n) => {
          clearTimeout(t);
          res(n);
        });
      });
      setReply(String(done.reply ?? done.error ?? ''));
    } catch (e) {
      setReply(`error: ${String((e as Error).message || e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <Link href="/" className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="text-[13px]">direct link</span>
      </header>

      <section className="oz-blk">
        <h2>bridge</h2>
        <ul className="oz-kv">
          <li>
            <span>state</span>
            <span data-testid="p2p-phase">{phase}</span>
            <span />
          </li>
          <li>
            <span>box key</span>
            <span className="break-all">{pin?.fp || '—'}</span>
            <span />
          </li>
        </ul>
        {why && (
          <p className="note" data-testid="p2p-why">
            {why}
          </p>
        )}
      </section>

      <section className="oz-blk">
        <h2>say something</h2>
        <textarea
          data-testid="p2p-input"
          className="w-full bg-transparent"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="oz-k"
          data-testid="p2p-send"
          disabled={phase !== 'open' || busy}
          onClick={send}
        >
          {busy ? 'waiting for the tree…' : 'send over the bridge'}
        </button>
        {reply && (
          <p className="note" data-testid="p2p-reply">
            {reply}
          </p>
        )}
      </section>
    </main>
  );
}

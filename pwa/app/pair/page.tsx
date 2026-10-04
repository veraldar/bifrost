'use client';

/** /pair — both halves of the QR handshake (v0.9 no-tailscale).
 *  On the box's console (no fragment): mints a one-time code and shows the
 *  QR, re-minting at expiry. On the phone (fragment v=1&code=…&fp=…&bridge=…):
 *  redeems the code, pins the bridge fingerprint (trust-on-first-scan) and
 *  lands on MAIN — zero typing, this IS the auto-setup. The fragment is wiped
 *  from history before anything else runs. */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LineIcon } from '@/components/line-icon';
import { savePin } from '@/lib/p2p';

type Code = {
  url: string;
  svg: string;
  exp: number;
  fingerprint: string | null;
  bridge: string | null;
  warning?: string;
};

const WHY: Record<string, string> = {
  used: 'this code was already used — ask the box for a fresh QR',
  expired: 'this code expired — ask the box for a fresh QR',
  invalid: 'this code is not one the box issued',
};

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'browser';
}

export default function PairPage() {
  const [mode, setMode] = useState<'console' | 'phone' | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const frag = new URLSearchParams(location.hash.slice(1));
    if (frag.get('code')) {
      setMode('phone');
      history.replaceState(null, '', '/pair');
      void claim(frag);
    } else {
      setMode('console');
      if (new URLSearchParams(location.search).get('unpaired')) {
        setStatus('this device is not paired — scan the QR on the box');
      }
      void mint();
    }
  }, []);

  // console: re-mint when the shown code expires
  useEffect(() => {
    if (mode !== 'console' || !code) return;
    const t = setTimeout(() => void mint(), Math.max(1000, code.exp - Date.now()));
    return () => clearTimeout(t);
  }, [mode, code]);

  async function mint() {
    const r = await fetch('/api/pair/code', { method: 'POST' });
    if (!r.ok) {
      setError('pairing codes come from the box itself — open /pair on the box');
      return;
    }
    setError('');
    setCode(await r.json());
  }

  async function claim(frag: URLSearchParams) {
    setStatus('pairing…');
    const r = await fetch('/api/pair/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: frag.get('code'), name: deviceName() }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      setStatus('');
      setError(WHY[body.why] || 'pairing failed');
      return;
    }
    const fp = frag.get('fp');
    const bridge = frag.get('bridge');
    if (fp && bridge) {
      savePin({ fp, bridge, box: frag.get('box') || 'box', deviceId: body.id, pairedAt: new Date().toISOString() });
    }
    setStatus(`paired as ${body.name} — opening MAIN`);
    location.replace(body.main ? `/session/${body.main.slug}?id=${body.main.id}` : '/');
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <Link href="/" className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="text-[13px]">pair a device</span>
      </header>

      {mode === 'console' && (
        <section className="oz-blk">
          <h2>scan with the phone</h2>
          {code && (
            <>
              <div
                data-testid="pair-qr"
                className="mx-auto my-3 w-64 bg-white p-2"
                dangerouslySetInnerHTML={{ __html: code.svg }}
              />
              <ul className="oz-kv">
                <li>
                  <span>expires</span>
                  <span>{new Date(code.exp).toLocaleTimeString()}</span>
                  <span />
                </li>
                <li>
                  <span>box key</span>
                  <span data-testid="pair-fp" className="break-all">
                    {code.fingerprint || '—'}
                  </span>
                  <span />
                </li>
              </ul>
              {code.warning && <p className="note">{code.warning}</p>}
              <p className="note">
                one use, five minutes. the QR carries the box key — your phone pins it and refuses
                any bridge that does not hold it.
              </p>
            </>
          )}
          <p className="note">
            <Link href="/devices">devices · revoke · kill-switch</Link>
          </p>
        </section>
      )}

      {(status || error) && (
        <section className="oz-blk">
          <p data-testid="pair-status" className="note">
            {error || status}
          </p>
        </section>
      )}
    </main>
  );
}

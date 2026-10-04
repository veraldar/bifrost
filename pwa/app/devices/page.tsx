'use client';

/** /devices — every paired device, its network region, revoke, and the
 *  KILL-SWITCH ("sever all bridges"): every device revoked, every live bridge
 *  peer dropped, every pairing code burned. Reachable from the box console
 *  and from any paired device — a safety control must be in the hand that
 *  needs it. */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LineIcon } from '@/components/line-icon';
import type { DeviceView } from '@/lib/devices';

type Registry = { devices: DeviceView[]; killEpoch: number; killedAt?: string };

export default function DevicesPage() {
  const [reg, setReg] = useState<Registry | null>(null);
  const [note, setNote] = useState('');

  async function load() {
    const r = await fetch('/api/pair');
    if (!r.ok) {
      setNote('not authorized — open this on the box or on a paired device');
      return;
    }
    setReg(await r.json());
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  async function revoke(id: string) {
    await fetch('/api/pair/devices', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await load();
  }

  async function kill() {
    if (!confirm('Sever ALL bridges? Every device is revoked and must re-pair.')) return;
    const r = await fetch('/api/pair/kill', { method: 'POST' });
    const out = await r.json().catch(() => ({}));
    setNote(r.ok ? `severed ${out.severed} device(s) — epoch ${out.epoch}` : 'kill-switch refused');
    await load();
  }

  const live = reg?.devices.filter((d) => !d.revoked) ?? [];
  const gone = reg?.devices.filter((d) => d.revoked) ?? [];

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-3 pb-6">
      <header className="oz-head justify-start gap-2.5">
        <Link href="/" className="oz-k sm">
          <LineIcon name="back" size={13} /> back
        </Link>
        <span className="text-[13px]">devices</span>
      </header>

      <section className="oz-blk">
        <h2>paired</h2>
        <ul className="oz-kv" data-testid="devices-live">
          {live.map((d) => (
            <li key={d.id} data-testid={`device-${d.id}`}>
              <span>{d.name}</span>
              <span>
                {d.lastRegion}
                {d.regionChanges ? ` · moved ×${d.regionChanges}` : ''}
              </span>
              <button className="oz-k sm" data-testid={`revoke-${d.id}`} onClick={() => revoke(d.id)}>
                revoke
              </button>
            </li>
          ))}
          {reg && !live.length && (
            <li>
              <span>none</span>
              <span />
              <span />
            </li>
          )}
        </ul>
        <p className="note">
          <Link href="/pair">pair another device</Link>
        </p>
      </section>

      <section className="oz-blk">
        <h2>kill-switch</h2>
        <button className="oz-k" data-testid="kill-switch" onClick={kill}>
          sever all bridges
        </button>
        <p className="note">
          every device revoked, every live connection dropped. recovery = scan a fresh QR.
          {reg?.killedAt ? ` last pulled ${new Date(reg.killedAt).toLocaleString()}.` : ''}
        </p>
        {note && (
          <p className="note" data-testid="devices-note">
            {note}
          </p>
        )}
      </section>

      {gone.length > 0 && (
        <section className="oz-blk">
          <h2>revoked</h2>
          <ul className="oz-kv">
            {gone.map((d) => (
              <li key={d.id} data-testid={`revoked-${d.id}`}>
                <span>{d.name}</span>
                <span>{d.revokedWhy}</span>
                <span />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

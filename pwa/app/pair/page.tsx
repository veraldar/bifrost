'use client';

/**
 * /pair — v0.9 no-tailscale onboarding (S1).
 * Mints a per-device token, shows it ONCE (text + QR), stores it locally.
 * The QR carries the raw token: scanning it into the phone's bridge page is
 * the pairing act — no accounts, no tailscale.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

export default function PairPage() {
  const [name, setName] = useState('phone');
  const [token, setToken] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownOnce = useRef(false);

  useEffect(() => {
    if (!token || shownOnce.current) return;
    shownOnce.current = true;
    localStorage.setItem('bifrost_device', token);
    // render QR client-side (token payload)
    import('qrcode')
      .then((QR) => QR.toDataURL(token, { margin: 1, width: 220 }))
      .then(setQr)
      .catch((e) => setError(`qr: ${e}`));
  }, [token]);

  async function pair() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `pair failed: ${r.status}`);
      }
      const j = await r.json();
      setToken(j.token);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-xl font-semibold">Pair a device</h1>
      <p className="mt-2 text-sm opacity-70">
        Mints a device token for this bifrost. The token is shown once — it
        opens the bridge (data channel + voice) without tailscale.
      </p>

      {!token ? (
        <div className="mt-6 flex flex-col gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="device name (e.g. pixel)"
            className="rounded border bg-transparent px-3 py-2 text-sm"
          />
          <button
            onClick={pair}
            disabled={busy}
            className="rounded border px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-50"
          >
            {busy ? 'pairing…' : 'Pair this device'}
          </button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-4">
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="device token QR" className="mx-auto rounded bg-white p-2" />
          )}
          <code className="break-all rounded border p-2 text-xs">{token}</code>
          <p className="text-xs opacity-60">
            Stored on this device. Shown once — a screenshot is the backup.
          </p>
          <Link
            href="/bridge"
            className="rounded border px-3 py-2 text-center text-sm hover:bg-white/5"
          >
            Open the bridge →
          </Link>
        </div>
      )}
    </main>
  );
}

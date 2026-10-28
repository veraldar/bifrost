'use client';

/** PROVIDER-WAVE (10-28): the banner that says why the tree stopped answering.
 *  "provider limit exhausted, resets 20:44" — the reset in the phone's clock,
 *  re-rendered each minute so "resets" turns into "should answer again" on
 *  time. Danger tone when the brain is out; info tone when a fallback is
 *  answering instead. Dismiss hides THIS alert only — a new one shows again. */
import { useEffect, useState } from 'react';
import { LineIcon } from '@/components/line-icon';
import { alertDetail, alertHeadline, alertLive, resetClock, type ProviderAlert } from '@/lib/provider-alert';

export type BannerState =
  | { mode: 'out'; alert: ProviderAlert; fallback?: string[] }
  | { mode: 'degraded'; alert: ProviderAlert; via: string };

function keyOf(b: BannerState): string {
  return `${b.mode}|${b.alert.kind}|${b.alert.resetsAt || 0}|${b.alert.providerID || ''}`;
}

export function ProviderBanner({ state }: { state: BannerState | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState('');
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!state || !alertLive(state.alert, now) || dismissed === keyOf(state)) return null;
  const a = state.alert;
  const out = state.mode === 'out';
  const head = out
    ? alertHeadline(a, now)
    : `answering via ${state.via} — ${alertHeadline(a, now)}`;
  const detail = out
    ? alertDetail(a) +
      (state.fallback && state.fallback.length ? ` · fallback: ${state.fallback.join(', ')}` : '')
    : a.resetsAt
      ? `${a.providerID || 'the default provider'} is back at ${resetClock(a.resetsAt, now)}`
      : alertDetail(a);
  return (
    <div
      role="alert"
      data-testid="provider-banner"
      data-kind={a.kind}
      data-mode={state.mode}
      className="oz-box mt-2 flex items-start gap-2 px-2.5 py-2 text-xs"
      style={{ borderColor: out ? 'var(--oz-danger)' : 'var(--oz-info)' }}
    >
      <span style={{ color: out ? 'var(--oz-danger)' : 'var(--oz-info)' }} aria-hidden>
        ⚠
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium" style={{ color: out ? 'var(--oz-danger)' : 'var(--oz-text)' }}>
          {head}
        </div>
        {detail && <div className="mt-0.5 break-words text-[var(--oz-dim)]">{detail}</div>}
      </div>
      <button
        aria-label="dismiss provider alert"
        onClick={() => setDismissed(keyOf(state))}
        className="text-[var(--oz-dim)] hover:text-[var(--oz-text)]"
      >
        <LineIcon name="close" size={11} />
      </button>
    </div>
  );
}

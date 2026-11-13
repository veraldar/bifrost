'use client';

/**
 * S1 client half: a same-origin /api call answering 401 with a `reauth` hint
 * gets ONE single-flight refresh (/api/pair/refresh, the path-scoped refresh
 * cookie rides it) and a retry. A refused refresh means this device is no
 * longer paired → /pair. Mounted once in the layout; inert in tailnet mode,
 * where the middleware never answers 401.
 */
import { useEffect } from 'react';

let inflight: Promise<boolean> | null = null;

function refreshOnce(orig: typeof fetch): Promise<boolean> {
  inflight ??= orig('/api/pair/refresh', { method: 'POST' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (inflight = null), 0));
  return inflight;
}

export function DeviceAuth() {
  useEffect(() => {
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await orig(input, init);
      if (res.status !== 401) return res;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(url, location.href);
      if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return res;
      // /pair is mid-handshake: its own claim decides, a refresh here can only race it
      if (u.pathname.startsWith('/api/pair') || location.pathname.startsWith('/pair')) return res;
      const hint = await res
        .clone()
        .json()
        .catch(() => null);
      if (hint?.reauth === 'refresh' && (await refreshOnce(orig))) return orig(input, init);
      if (hint?.reauth) location.assign('/pair?unpaired=1');
      return res;
    };
    return () => {
      window.fetch = orig;
    };
  }, []);
  return null;
}

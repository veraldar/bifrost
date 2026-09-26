/** Frontend diagnostics, fully automatic: console errors, crashes, network
 *  calls (status + duration), user taps and page loads are recorded to a
 *  persistent ring buffer and uploaded in batches to /api/diag, which logs
 *  them to the server (journalctl + pwa/.diag/*.log). Manual export (🐞 /
 *  ozDiagDump()) remains as a fallback only. */

const KEY = 'oz-diag';
const ID_KEY = 'oz-diag-id';
const MAX_RECENT = 600;
const MAX_PENDING = 400;
const FLUSH_MS = 10_000;
const FLUSH_AT = 40;

type Ev = { t: number; kind: string; msg: string };

let recent: Ev[] = [];
let pending: Ev[] = [];
let clientId = '';
let flushing = false;
let pollFailStreak = 0;

function push(kind: string, msg: string): void {
  const ev = { t: Date.now(), kind, msg: String(msg).slice(0, 2000) };
  recent.push(ev);
  if (recent.length > MAX_RECENT) recent = recent.slice(-MAX_RECENT);
  pending.push(ev);
  if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
  try {
    localStorage.setItem(KEY, JSON.stringify(recent));
  } catch {
    /* storage full — keep the in-memory ring */
  }
  if (pending.length >= FLUSH_AT) void flush('full');
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function flush(reason: string): Promise<void> {
  if (flushing || !pending.length || typeof fetch === 'undefined') return;
  flushing = true;
  const batch = {
    client: clientId,
    page: location.pathname,
    reason,
    events: pending.splice(0, pending.length),
  };
  try {
    const r = await fetch('/api/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(batch),
      keepalive: true,
    });
    if (!r.ok) pending.unshift(...batch.events); // retry next cycle
  } catch {
    pending.unshift(...batch.events);
  } finally {
    flushing = false;
  }
}

function flushBeacon(): void {
  if (!pending.length) return;
  const batch = JSON.stringify({
    client: clientId,
    page: location.pathname,
    reason: 'unload',
    events: pending.splice(0, pending.length),
  });
  try {
    navigator.sendBeacon('/api/diag', batch);
  } catch {
    void flush('unload-fallback');
  }
}

/** Timings for every network call; polls are only recorded on failure or
 *  when slow, everything else always. */
function wrapFetch(): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const url = typeof args[0] === 'string' ? args[0] : ((args[0] as Request)?.url ?? '');
    const method =
      typeof args[0] === 'string'
        ? (args[1]?.method ?? 'GET')
        : ((args[0] as Request).method ?? 'GET');
    const isPoll = method === 'GET' && /\/messages(\?|$)/.test(url);
    const t0 = performance.now();
    try {
      const r = await origFetch(...args);
      const ms = Math.round(performance.now() - t0);
      if (isPoll) pollFailStreak = 0;
      if (!r.ok) {
        // capture the error body (proxies return {error} JSON) so the log
        // pinpoints server-side causes, not just status codes
        let body = '';
        try {
          body = (await r.clone().text()).slice(0, 160);
        } catch {
          /* opaque/bodyless */
        }
        push('net-fail', `${r.status} ${ms}ms ${method} ${url}${body ? ` · ${body}` : ''}`);
      } else if (!isPoll) push('net', `${r.status} ${ms}ms ${method} ${url}`);
      else if (ms > 3000) push('net-slow', `${r.status} ${ms}ms ${method} ${url}`);
      return r;
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      // polls retry every 2.5s on their own — a lone failure (radio doze,
      // brief Wi-Fi drop, frozen-tab socket kill) self-heals and is noise;
      // only sustained failure is actionable, else every outage logs a burst
      if (isPoll && ++pollFailStreak < 3) throw e;
      pollFailStreak = 0;
      push('net-fail', `ERR ${ms}ms ${method} ${url} ${e}`);
      throw e;
    }
  };
}

export function initDiag(): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__ozDiag) return;
  w.__ozDiag = true;

  try {
    clientId = localStorage.getItem(ID_KEY) || '';
    if (!clientId) {
      clientId = crypto.randomUUID?.() || `c${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(ID_KEY, clientId);
    }
  } catch {
    clientId = 'anon';
  }

  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '[]') as Ev[];
    if (Array.isArray(stored)) {
      recent = stored.slice(-MAX_RECENT);
      pending.push(...stored.slice(-100)); // re-upload what may not have made it
    }
  } catch {
    recent = [];
  }

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...a: unknown[]) => {
    push('console.error', a.map(fmt).join(' '));
    origError(...a);
  };
  console.warn = (...a: unknown[]) => {
    push('console.warn', a.map(fmt).join(' '));
    origWarn(...a);
  };

  window.addEventListener('error', (e) =>
    push('crash', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`)
  );
  window.addEventListener('unhandledrejection', (e) => push('unhandled', String(e.reason)));

  wrapFetch();

  document.addEventListener(
    'click',
    (e) => {
      const el = (e.target as HTMLElement)?.closest('button,a,[role="button"]');
      if (el) {
        const label = (el.getAttribute('aria-label') || el.textContent || 'element')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 60);
        push('tap', label);
      }
    },
    true
  );

  const nav = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  if (nav) {
    push(
      'load',
      `domContentLoaded ${Math.round(nav.domContentLoadedEventEnd - nav.startTime)}ms, ` +
        `load ${Math.round(nav.loadEventEnd - nav.startTime)}ms`
    );
  }
  push(
    'open',
    `${navigator.userAgent} · ${screen.width}x${screen.height} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
  );

  setInterval(() => void flush('timer'), FLUSH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushBeacon();
  });
  window.addEventListener('pagehide', flushBeacon);

  (window as any).ozDiagDump = diagDump;
  (window as any).ozDiagDownload = diagDownload;
  void flush('init');
}

export function diagDump(): string {
  return recent.map((e) => `${new Date(e.t).toISOString()} [${e.kind}] ${e.msg}`).join('\n');
}

/** Record an app-level event (voice, errors, …) into the diag pipeline. */
export function diagEvent(kind: string, msg: string): void {
  push(kind, msg);
}

export function diagDownload(): void {
  const blob = new Blob([diagDump() || '(empty)'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pwa-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Reply-ready notifications: asks permission once (first send), then shows
 *  a notification via the service worker when a reply lands while the app
 *  is backgrounded — or for any session the user asked a question in. */

const ASKED_KEY = 'oz-asked';

function readAsked(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(ASKED_KEY) || '{}');
  } catch {
    return {};
  }
}

export function markAsked(slug: string): void {
  try {
    const d = readAsked();
    d[slug] = Date.now();
    localStorage.setItem(ASKED_KEY, JSON.stringify(d));
  } catch {
    /* private mode */
  }
}

export function clearAsked(slug: string): void {
  try {
    const d = readAsked();
    delete d[slug];
    localStorage.setItem(ASKED_KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}

export function askedSessions(): string[] {
  return Object.keys(readAsked());
}

/** Prompt once — call from a user gesture (first send). On grant, also
 *  subscribes to Web Push so the server can wake the phone even when the
 *  tab is frozen (in-page notifications never fire in that state). */
export async function ensureNotifyPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission === 'default') {
    try {
      if ((await Notification.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
  }
  if (Notification.permission !== 'granted') return false;
  void subscribePush(); // best effort — local notifications still work
  return true;
}

function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function subscribePush(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.register('/sw.js');
    const r = await fetch('/api/push', { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return;
    const { publicKey } = await r.json();
    if (!publicKey) return;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* push optional — permission still granted for in-page fallback */
  }
}

/** Fire-and-forget reply notification (no-ops without granted permission). */
export async function notifyReply(slug: string): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const options: NotificationOptions & { data: { slug: string } } = {
    body: `reply ready — ${slug}`,
    tag: `oz-${slug}`,
    icon: '/favicon.ico',
    data: { slug },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification('opencode', options);
    else new Notification('opencode', options);
  } catch {
    /* notifications unavailable */
  }
}

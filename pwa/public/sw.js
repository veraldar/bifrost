/* Minimal service worker: notification clicks focus/open the session. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/* Web Push: the proxy fires this the moment a run finishes — works even
 * when Chrome froze the page (in-page Notification() can't).
 * Delivery-ratio instrumentation (Rung 0): a shown notification is posted
 * to /api/diag as `[push] shown` — the server logged the matching
 * `[push] sent` denominator at send time. */
self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    /* plain-text or empty payload */
  }
  e.waitUntil(
    (async () => {
      await self.registration.showNotification('opencode', {
        body: data.body || 'reply ready',
        tag: data.tag || 'oz-reply',
        icon: '/favicon.ico',
        data: { slug: data.slug },
      });
      try {
        await fetch('/api/diag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client: 'sw',
            page: 'sw',
            reason: 'push-shown',
            events: [
              {
                t: Date.now(),
                kind: 'push',
                msg: `shown tag=${data.tag || 'oz-reply'} slug=${data.slug || '?'}`,
              },
            ],
          }),
        });
      } catch {
        /* ratio telemetry is best-effort — display already succeeded */
      }
    })()
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const slug = (e.notification.data || {}).slug;
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (slug && c.url.includes(`/session/${slug}`)) return c.focus();
      }
      for (const c of all) {
        if ('focus' in c) {
          if (slug) c.navigate(`/session/${slug}`).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(slug ? `/session/${slug}` : '/');
    })()
  );
});

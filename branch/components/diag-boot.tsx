'use client';

import { useEffect } from 'react';
import { initDiag } from '@/lib/diag';

/** Mounts once from the root layout: starts diagnostics recording and
 *  registers the service worker (notifications + PWA install). */
export function DiagBoot() {
  useEffect(() => {
    initDiag();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* SW is optional */
      });
    }
  }, []);
  return null;
}

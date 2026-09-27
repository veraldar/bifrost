'use client';

import { useEffect } from 'react';

/** Auto-reload stale tabs: a long-lived PWA tab keeps running the JS bundle
 *  it booted with — deploys then look like they "don't work" on the phone.
 *  On becoming visible, compare the server's build id with the one this tab
 *  booted on; a mismatch means a deploy landed while we were backgrounded →
 *  reload once (drafts are persisted, so the cost is ~a reload flicker). */
export function FreshReload() {
  useEffect(() => {
    const key = 'oz-build';
    const check = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch('/api/build', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        const { id, ttsVoice } = (await r.json()) as { id: string; ttsVoice?: string };
        if (ttsVoice) sessionStorage.setItem('oz-tts-voice', ttsVoice);
        if (!id || id === 'unknown') return;
        const seen = sessionStorage.getItem(key);
        if (seen && seen !== id) {
          sessionStorage.setItem(key, id);
          location.reload();
        } else if (!seen) {
          sessionStorage.setItem(key, id);
        }
      } catch {
        /* offline — ignore */
      }
    };
    void check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);
  return null;
}

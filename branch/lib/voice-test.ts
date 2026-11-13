/** Voice tests get their own room (UX-BATCH #5, 10-23): voice testing in MAIN
 *  filled the user's main conversation with "Bifrost bridge voice test" turns.
 *  A device-local switch (settings → voice tests): while on, MAIN opens the
 *  `voice-test` session instead — room = session slug, and the agent maps a
 *  room to the session of the same slug, so every voice turn lands there and
 *  MAIN is never joined, never written. Off: MAIN again. Browser-only. */
import { isMainSlug } from './tree-first';

export const VOICE_TEST_KEY = 'bifrost-voice-test';
export const VOICE_TEST_SLUG = 'voice-test';

export function voiceTestOn(): boolean {
  try {
    return localStorage.getItem(VOICE_TEST_KEY) === '1';
  } catch {
    return false;
  }
}

/** where a session link really goes on this device */
export function voiceTestRedirect(slug: string): string | null {
  return isMainSlug(slug) && voiceTestOn() ? VOICE_TEST_SLUG : null;
}

/** the test room must exist before its first turn (the session view
 *  resolves a slug, it does not create one) */
export async function ensureVoiceTestRoom(): Promise<void> {
  // the proxy resolves a slug over the whole store (the list is capped)
  const probe = await fetch(`/api/session/${VOICE_TEST_SLUG}/messages?limit=1`, {
    cache: 'no-store',
  });
  if (probe.ok) return;
  const r = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: VOICE_TEST_SLUG }),
  });
  if (!r.ok) throw new Error(`could not create ${VOICE_TEST_SLUG} (${r.status})`);
}

/** switch on: the room first (see ensureVoiceTestRoom) */
export async function setVoiceTest(on: boolean): Promise<void> {
  if (on) await ensureVoiceTestRoom();
  try {
    if (on) localStorage.setItem(VOICE_TEST_KEY, '1');
    else localStorage.removeItem(VOICE_TEST_KEY);
  } catch {
    /* private mode: the switch cannot stick */
  }
}

/** The voice line's one way in: POST /api/token (room = session slug) — shared
 *  by MAIN's composer (app/session/[slug]) and the roots (lib/roots-voice).
 *
 *  Voice is a STATE of the connection, never an error: a phone paired through
 *  the trunk (devices mode, reached via the access point) has no LiveKit it
 *  can reach — voice over the trunk is not built yet (it comes with WebRTC
 *  through the access point's TURN). The route says so as
 *  `503 {error:"voice-unavailable", why}`; the first such answer is kept for
 *  the life of the page, so the mic and hands-free controls show one calm
 *  line and never ask again (no retry storm). Any other answer it cannot read
 *  — an empty 500, a proxy's HTML — is a plain error with a clear message,
 *  never the raw "Unexpected end of JSON input". */

export const VOICE_UNAVAILABLE = 'voice-unavailable';

/** the one line the app shows for it */
export const VOICE_OFF_NOTE = {
  en: "Voice isn't available over the trunk yet — type instead",
  fr: 'La voix ne passe pas encore par le tronc — écrivez plutôt',
} as const;

export type VoiceToken = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
};

export class VoiceUnavailable extends Error {
  readonly why: string;
  constructor(why: string) {
    super(VOICE_UNAVAILABLE);
    this.name = 'VoiceUnavailable';
    this.why = why;
  }
}

export const isVoiceUnavailable = (e: unknown): e is VoiceUnavailable =>
  e instanceof VoiceUnavailable;

let off: VoiceUnavailable | null = null;

/** voice is known to be unavailable on this connection (this page load) */
export function voiceOff(): VoiceUnavailable | null {
  return off;
}

let probe: Promise<boolean> | null = null;

/** can voice work on this connection? Asked (GET /api/token: mints nothing)
 *  only where the app would otherwise ask for the mic first — a phone on the
 *  trunk is never prompted for a mic it cannot use. Once per page load; an
 *  answer it cannot read counts as "yes" (the mint itself will say). */
export function voiceProbe(): Promise<boolean> {
  if (off) return Promise.resolve(false);
  probe ??= fetch('/api/token', { cache: 'no-store' })
    .then(async (r) => {
      const d = parse(await r.text().catch(() => ''));
      if (d?.error !== VOICE_UNAVAILABLE) return true;
      off ??= new VoiceUnavailable(String(d.why || ''));
      return false;
    })
    .catch(() => true);
  return probe;
}

/** a body that may be empty, JSON, or neither */
function parse(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const d = JSON.parse(text);
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** mint the room's join token — throws VoiceUnavailable (remembered) when
 *  voice cannot work on this connection */
export async function voiceToken(room: string): Promise<VoiceToken> {
  if (off) throw off;
  const r = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room }),
  });
  const text = await r.text().catch(() => '');
  const d = parse(text);
  if (d?.error === VOICE_UNAVAILABLE) {
    off = new VoiceUnavailable(String(d.why || ''));
    throw off;
  }
  if (!r.ok || typeof d?.serverUrl !== 'string' || typeof d?.participantToken !== 'string') {
    const raw = text.trim();
    const said = d
      ? String(d.why || d.error || 'no token in the answer')
      : !raw
        ? 'empty answer'
        : raw.startsWith('<')
          ? 'not JSON'
          : raw.slice(0, 120);
    throw new Error(`no voice token (${r.status} — ${said})`);
  }
  return d as unknown as VoiceToken;
}

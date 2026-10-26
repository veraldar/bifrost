/** MAIN's voice primitives, shared (MAINFRAME-C, 10-26): the session view and
 *  the front page's roots talk to the same voice agent through the same room
 *  (room = session slug), so the pieces that are pure protocol live here.
 *  Moved verbatim out of app/session/[slug]/page.tsx — MAIN imports them, its
 *  behavior is unchanged. */
import { type Room, Track } from 'livekit-client';

/** echo gate tail: the speaker's output buffer + the room's reverb outlive
 *  the audio element's end by a few hundred ms */
export const ECHO_TAIL_MS = 400;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${what} timeout (${ms / 1000}s)`)), ms)
    ),
  ]);
}

/** The voice agent can lag the room join (fresh dispatch after a page
 *  reload or a teardown): poll briefly instead of dropping the turn — a
 *  commit fired while `remoteParticipants` is still empty reaches nobody
 *  and the hold is lost silently (req 09-29 'switching from hand free to
 *  keyboard and then using the push to talk is not working'). */
export async function agentInRoom(room: Room, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const agent = Array.from(room.remoteParticipants.values())[0];
    if (agent) return agent;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** Text-mode PTT: release the CAPTURE DEVICE between holds. A muted track
 *  still holds the mic hardware (phone shows 'mic in use' — req 09-29
 *  'mic on only on push to talk'), and a full room teardown forces a
 *  reconnect on the next press — slower than the hold on a laggy link.
 *  So the room + agent stay warm; unpublishing stops the device, and the
 *  next hold's setMicrophoneEnabled(true) re-acquires it (~200ms). */
export function releaseMicDevice(room: Room) {
  const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (pub?.track) {
    try {
      room.localParticipant.unpublishTrack(pub.track, true);
    } catch {
      /* track already gone */
    }
  }
}

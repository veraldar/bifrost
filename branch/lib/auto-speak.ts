/** QUIET-ASSESS law (owner 11-10): an assistant reply to an automated verdict
 *  request (brain stamps info.meta.autoReply) is not spoken on arrival — the
 *  coordinator assesses silently and only speaks when the owner must act.
 *  OWNER-ACTION: in the text keeps the voice. A manual replay tap bypasses this. */
export const OWNER_ACTION_MARKER = 'OWNER-ACTION:';

export function shouldAutoSpeak(m: { text: string; autoReply?: boolean }): boolean {
  return !m.autoReply || m.text.includes(OWNER_ACTION_MARKER);
}

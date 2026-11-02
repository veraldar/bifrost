/**
 * TURN credentials — coturn REST API (RFC draft-uberti-Beijing-turn-rest).
 * Shared secret lives in /etc/turnserver.conf on the VPS (static-auth-secret);
 * the PWA HMACs a unix-expiry username to produce the credential coturn
 * expects. Time-limited (default 6 h) — no long-lived TURN password anywhere.
 *
 * The same algorithm is what `turnutils_uclient -u <expiry> -w <b64>` used to
 * prove the TCP relay on the VPS, so the two ends are pinned together.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const TURN_URLS = [
  'turn:179-237-67-146.nip.io:443?transport=tcp',
  'turn:179-237-67-146.nip.io:3478?transport=udp',
];

export function turnSecret(): string {
  return process.env.TURN_SECRET || '';
}

export function turnTtlSec(): number {
  const n = Number(process.env.TURN_TTL_SEC || 6 * 3600);
  return Number.isFinite(n) && n > 60 ? n : 6 * 3600;
}

/** REST-auth credential pair for `urls`, valid ~ttl from now. */
export function turnCreds(secret: string, ttlSec = turnTtlSec()) {
  const username = String(Math.floor(Date.now() / 1000) + Math.max(60, ttlSec));
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, urls: TURN_URLS, ttlSec };
}

/** Constant-time check that a presented admin token matches (fail closed). */
export function adminTokenOk(presented: string | null): boolean {
  const want = process.env.BIFROST_ADMIN_TOKEN || '';
  if (!want || !presented) return false;
  const a = Buffer.from(presented.trim());
  const b = Buffer.from(want.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

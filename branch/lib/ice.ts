/**
 * ICE servers for the bridge's WebRTC join — the user's own access point, or
 * nothing at all.
 *
 * Spec invariants (docs/spec-pairing.md 2 + 4): no third-party STUN/TURN, and
 * the access point is the user's — a server they rent, in the country they
 * choose. So there is NO built-in host here: unconfigured, the answer is
 * `iceServers: []` (LAN host candidates only, which is all LAN pairing needs).
 *
 * Configuration (server env, never shipped to the client bundle):
 *   BIFROST_TURN_URLS    comma-separated turn:/turns:/stun: URLs of the user's
 *                        access point, e.g. `turn:ap.example.net:3478?transport=udp`
 *   BIFROST_TURN_SECRET  its coturn `static-auth-secret` — REST auth
 *                        (draft-uberti-behave-turn-rest): the username is a unix
 *                        expiry and the credential its HMAC, so no long-lived TURN
 *                        password exists anywhere
 *   BIFROST_TURN_TTL_S   credential lifetime (default 6 h, minimum 60 s)
 *
 * A turn: URL without a secret is dropped (it could never authenticate).
 */
import { createHmac } from 'crypto';

export type IceServer = { urls: string[]; username?: string; credential?: string };

export function turnUrls(): string[] {
  return (process.env.BIFROST_TURN_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^(turns?|stun):/i.test(u));
}

export function turnTtlSec(): number {
  const n = Number(process.env.BIFROST_TURN_TTL_S || 6 * 3600);
  return Number.isFinite(n) && n >= 60 ? n : 6 * 3600;
}

/** REST-auth credential pair, valid ~ttl from now (username IS the expiry). */
export function turnCreds(secret: string, ttlSec = turnTtlSec()) {
  const username = String(Math.floor(Date.now() / 1000) + Math.max(60, ttlSec));
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/** What `new RTCPeerConnection({ iceServers })` gets: [] unless configured. */
export function iceServers(): IceServer[] {
  const urls = turnUrls();
  const secret = process.env.BIFROST_TURN_SECRET || '';
  const stun = urls.filter((u) => /^stun:/i.test(u));
  const turn = secret ? urls.filter((u) => /^turns?:/i.test(u)) : [];
  const out: IceServer[] = [];
  if (stun.length) out.push({ urls: stun });
  if (turn.length) out.push({ urls: turn, ...turnCreds(secret) });
  return out;
}

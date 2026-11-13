/**
 * v0.9 no-tailscale serve: `node server.mjs` instead of `next start`.
 *
 * Which entry runs when:
 *   BIFROST_AUTH=devices (pairing) → `node server.mjs` — REQUIRED (below). The
 *     installer's bifrost-app.service runs exactly this.
 *   BIFROST_AUTH=tailnet → `next start` (npm start) as before, behind
 *     `tailscale serve`; server.mjs works there too.
 * Both serve the same `next build` output. Under any entry but this one,
 * lib/region.ts reads NO peer (BIFROST_PEER_STAMP below is unset): a
 * client-sent x-bifrost-peer is never believed, so devices mode misserved by
 * `next start` fails closed (region "unknown", no console) instead of open.
 *
 * The ONE place the peer address is known. Plain `next start` keeps a
 * client-sent X-Forwarded-For (base-server `??=`), so a LAN client could claim
 * to be loopback (= the box console = pairing admin) or fake its network
 * region. Here every request gets `x-bifrost-peer` from the socket, and any
 * client-sent copy is deleted first. Behind a reverse proxy YOU run, set
 * BIFROST_TRUST_PROXY=1 to take the first X-Forwarded-For hop instead.
 *
 * Env: PORT (8095), HOST (0.0.0.0), BIFROST_TRUST_PROXY.
 */
import next from 'next';
import { createServer } from 'node:http';

const port = Number(process.env.PORT || 8095);
const hostname = process.env.HOST || '0.0.0.0';
const trustProxy = process.env.BIFROST_TRUST_PROXY === '1';

// in-process marker (never from the env file): x-bifrost-peer is ours to read
process.env.BIFROST_PEER_STAMP = 'server.mjs';

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();

createServer((req, res) => {
  const forwarded = trustProxy
    ? String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim()
    : '';
  delete req.headers['x-bifrost-peer'];
  if (!trustProxy) delete req.headers['x-forwarded-for'];
  req.headers['x-bifrost-peer'] = forwarded || req.socket.remoteAddress || '';
  handle(req, res);
}).listen(port, hostname, () => {
  console.log(`bifrost pwa on http://${hostname}:${port} (peer-stamped, trustProxy=${trustProxy})`);
});

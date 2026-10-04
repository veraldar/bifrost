/**
 * Network region — the coarse "where is this device" bucket an access token
 * is bound to (S1: token bound to first-seen network region, re-auth on
 * region change). No GeoIP: the region is the network a request arrives from.
 * Mirrored 1:1 by lab/bifrost-net/src/region.rs — change both or neither.
 *
 *   loopback               127/8, ::1 (the box's own console)
 *   lan:a.b.c.0/24         RFC1918 10/8, 172.16/12, 192.168/16 — per /24
 *   cgnat:100.64.0.0/10    CGNAT / tailnet
 *   link                   169.254/16, fe80::/10
 *   lan6:xxxx:xxxx:xxxx::/48  IPv6 ULA fc00::/7
 *   net:a.b.0.0/16         public IPv4 (carrier pools rotate inside a /16)
 *   net6:xxxx:xxxx::/32    public IPv6
 *   unknown                no trustworthy peer address (served by plain
 *                          `next start` instead of server.mjs)
 *
 * The peer address comes ONLY from `x-bifrost-peer`, which server.mjs sets
 * from the socket after deleting any client-sent copy. Plain `next start`
 * trusts client-sent X-Forwarded-For (base-server `??=`), so it is never read.
 */

export function peerOf(req: { headers: Headers }): string {
  return (req.headers.get('x-bifrost-peer') || '').trim();
}

export function regionOf(ip: string): string {
  let a = (ip || '').trim().toLowerCase().replace(/%.*$/, '');
  if (!a) return 'unknown';
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  if (a.includes('.')) {
    const o = a.split('.').map((n) => (/^\d{1,3}$/.test(n) ? Number(n) : -1));
    if (o.length !== 4 || o.some((n) => n < 0 || n > 255)) return 'unknown';
    if (o[0] === 127) return 'loopback';
    if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168))
      return `lan:${o[0]}.${o[1]}.${o[2]}.0/24`;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'cgnat:100.64.0.0/10';
    if (o[0] === 169 && o[1] === 254) return 'link';
    return `net:${o[0]}.${o[1]}.0.0/16`;
  }
  const g = hextets(a);
  if (!g) return 'unknown';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  const hx = (n: number) => n.toString(16).padStart(4, '0');
  if ((g[0] & 0xfe00) === 0xfc00) return `lan6:${hx(g[0])}:${hx(g[1])}:${hx(g[2])}::/48`;
  if ((g[0] & 0xffc0) === 0xfe80) return 'link';
  return `net6:${hx(g[0])}:${hx(g[1])}::/32`;
}

function hextets(a: string): number[] | null {
  const parse = (s: string) => (s ? s.split(':') : []);
  let parts: string[];
  if (a.includes('::')) {
    const [head, tail] = a.split('::');
    const h = parse(head);
    const t = parse(tail);
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    parts = [...h, ...Array(fill).fill('0'), ...t];
  } else {
    parts = parse(a);
  }
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

export const regionOfReq = (req: { headers: Headers }) => regionOf(peerOf(req));

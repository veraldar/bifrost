/** GET /api/ping → 'pong'. The cheapest /api route: an RTT probe, and what
 *  the pairing specs (auth, pair-ladder) ask to see whether a credential
 *  clears the devices-mode gate (middleware.ts) — 200 paired, 401 not. */
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response('pong', {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
  });
}

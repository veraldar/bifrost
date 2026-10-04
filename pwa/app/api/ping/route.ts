/** GET /api/ping → 'pong'. Minimal RTT probe for the client diag: measures
 *  the tailnet phone↔box round trip during TTS playback so chunk gaps can be
 *  attributed to the network leg vs synthesis vs playback mechanics. */
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response('pong', {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
  });
}

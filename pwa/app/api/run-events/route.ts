/**
 * GET /api/run-events?slug=… → SSE stream of run-completion nudges.
 *
 * The watchdog's opencode SSE sees every run finish the moment it happens;
 * this channel lets a connected page refresh instantly instead of waiting
 * for its next transcript poll (the hands-free auto-listen used to lag up
 * to one poll interval behind the completed reply).
 */
import { resolveId } from '@/lib/oc';
import { onRunDone } from '@/lib/run-events';
import { ensureWatchdog } from '@/lib/oc-watchdog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sid = await resolveId(searchParams.get('slug') || '').catch(() => '');
  if (!sid) return new Response('unknown session', { status: 400 });
  ensureWatchdog(); // global-guarded: exactly one watchdog per process

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const push = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* client vanished */
        }
      };
      const off = onRunDone((doneSid, reason) => {
        if (doneSid === sid) push(`data: ${reason}\n\n`);
      });
      // heartbeat as a REAL message (comments are invisible to
      // EventSource.onmessage): the hands-free page reads any traffic as
      // proof the stream is alive and only escapes on true silence
      const hb = setInterval(() => push('data: hb\n\n'), 25_000);
      req.signal.addEventListener('abort', () => {
        clearInterval(hb);
        off();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      controller.enqueue(enc.encode('retry: 3000\n\n'));
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  });
}

/** Async prompt lifecycle shared by the messages + abort routes: fire-and-
 *  forget one message at opencode, track it in the live registry, pick up the
 *  next queued message when the run ends (abort included — the proxy owns
 *  queue pickup because opencode's own queue stalls forever after an abort). */
import { ocFetch } from './oc';
import { bustCache } from './oc-cache';
import { abortedAt, markRunEnd, markRunStart } from './oc-live';
import { dequeue } from './oc-queue';
import { emitRunError } from './run-events';
import { pushRunDone } from './push';

export type SendBody = {
  text?: string;
  images?: string[];
  files?: { name: string; content: string }[];
};

export function buildParts(body: SendBody): any[] {
  const parts: any[] = [];
  const text = String(body.text || '').trim();
  if (text) parts.push({ type: 'text', text });
  for (const dataUrl of body.images || []) {
    // opencode accepts attachments as file parts with a data: url
    // ({type:'image'} is rejected with 400 — verified against the live server)
    const mime = /^data:([^;,]+)/.exec(String(dataUrl))?.[1] || 'image/png';
    parts.push({ type: 'file', mime, url: dataUrl });
  }
  for (const f of body.files || []) {
    // md/txt/html arrive as fenced content so the model sees them verbatim
    parts.push({
      type: 'text',
      text: `\n\n--- attached file: ${f.name} ---\n\`\`\`\n${String(f.content).slice(0, 200_000)}\n\`\`\``,
    });
  }
  return parts;
}

/** Positive verification that opencode actually ran the prompt: it is in the
 *  transcript AND an assistant message follows it. Only positive evidence of
 *  a swallow re-fires — a failed verify GET must not duplicate a real run. */
async function runVerified(sid: string, sentText: string): Promise<boolean> {
  try {
    const msgs = (await ocFetch(`/session/${sid}/message`)) as any[];
    const parsed = (msgs || [])
      .map((m: any) => ({
        role: m.info?.role || m.role,
        text: (m.parts || [])
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text || '')
          .join('\n')
          .trim(),
      }))
      .filter((m: any) => m.text);
    const lastUser = parsed.map((m: any) => m.role).lastIndexOf('user');
    if (lastUser === -1 || !parsed[lastUser].text.includes(sentText)) return false;
    return parsed.slice(lastUser + 1).some((m: any) => m.role === 'assistant');
  } catch {
    return true; // can't verify → assume fine, a retry could double-send
  }
}

/** Fire-and-forget one message at opencode. Its end (abort included) is what
 *  lets the next queued message through — the proxy owns queue pickup. */
export function forward(sid: string, slug: string, body: SendBody, isRetry = false) {
  void (async () => {
    const t0 = Date.now();
    markRunStart(sid, t0);
    const sentText = String(body.text || '').trim();
    let refire = false;
    try {
      await ocFetch(`/session/${sid}/message`, {
        method: 'POST',
        body: JSON.stringify({ parts: buildParts(body) }),
      });
      console.log(`[oc] async prompt done ${Date.now() - t0}ms`);
      // opencode v1.18 occasionally swallows a POST right after an abort
      // (200, no run, no reply — seen live: prompt done in ~200ms that
      // should take 20s). Verify the run happened; one bounded silent
      // retry, never for a deliberate stop (spec rule 5).
      if (!isRetry && sentText && abortedAt(sid) < t0 && !(await runVerified(sid, sentText))) {
        console.warn(`[oc] run not verified for ${sid} — refiring once`);
        refire = true;
      }
    } catch (e) {
      // sid in the log: a bare "fetch failed" is unattributable when several
      // sessions are failing at once (2026-09-30 diagnosis blocker)
      console.error(`[oc] async prompt failed for ${sid}: ${e}`);
      // the phone must not sit on "working…" for a prompt opencode rejected —
      // surface it now (2026-09-30: a dead prompt held busy for 15 minutes)
      emitRunError(sid, `the reply failed: ${String(e).slice(0, 120)}`);
    }
    if (refire) {
      forward(sid, slug, body, true); // the retry owns run-end + queue pickup
      return;
    }
    // entry already cleared (abort route or poll heal got there first)?
    // that path owns the queue pickup — double-draining would fire two
    // messages at opencode at once, and its own queue stalls after aborts
    if (!markRunEnd(sid)) return;
    bustCache(); // list drops the "awaiting answer" state
    void pushRunDone(slug);
    // queue pickup: an abort also lands here, so stop advances to the
    // next queued message instead of stalling the session
    const next = dequeue(sid);
    if (next) forward(sid, slug, next);
  })();
}

/** End-of-run bookkeeping for runs whose owning fetch is gone (a proxy
 *  restart orphans the in-flight POST, so its .finally can never fire and
 *  the registry entry goes zombie: blinking dot + "queued" everything,
 *  forever). Also drains the queue when nothing else will. */
export function runEnded(sid: string, slug: string) {
  markRunEnd(sid);
  bustCache();
  const next = dequeue(sid);
  if (next) forward(sid, slug, next);
}

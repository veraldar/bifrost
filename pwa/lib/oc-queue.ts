/** Proxy-managed per-session FIFO: messages sent while a run is live wait
 *  here instead of opencode's internal queue — opencode v1.18 stalls its own
 *  queue forever after an abort, so the proxy owns pickup: when the live run
 *  ends (abort included) the next message is forwarded automatically.
 *  Persisted to disk: a restart must not eat queued messages.
 *
 *  Identity-pinned waits (herdr §1.4): a queue is keyed by session ID (the
 *  occupant), never by name — and it dies with its session: DELETE purges
 *  it, so nothing queued under a dead session is ever forwarded. */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const FILE = path.join(process.cwd(), '.oc-queue.json');

export type QueueItem = {
  text: string;
  images: string[];
  files: { name: string; content: string }[];
  at: number;
};

const queues = new Map<string, QueueItem[]>();

let loaded = false;
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  readFile(FILE, 'utf8')
    .then((raw) => {
      for (const [sid, items] of Object.entries(JSON.parse(raw) as Record<string, QueueItem[]>)) {
        if (Array.isArray(items) && items.length) queues.set(sid, items);
      }
    })
    .catch(() => {
      /* first boot */
    });
}

function persist() {
  void writeFile(FILE, JSON.stringify(Object.fromEntries(queues))).catch(() => {});
}

export function enqueue(
  sid: string,
  item: Omit<QueueItem, 'at'>
): void {
  ensureLoaded();
  const q = queues.get(sid) || [];
  q.push({ ...item, at: Date.now() });
  queues.set(sid, q);
  persist();
}

export function dequeue(sid: string): QueueItem | null {
  ensureLoaded();
  const q = queues.get(sid);
  if (!q?.length) return null;
  const item = q.shift()!;
  if (!q.length) queues.delete(sid);
  persist();
  return item;
}

/** The session died: nothing queued under it may ever fire. */
export function purgeQueue(sid: string): void {
  ensureLoaded();
  if (queues.delete(sid)) persist();
}

export function queuedItems(sid: string): QueueItem[] {
  ensureLoaded();
  return queues.get(sid) || [];
}

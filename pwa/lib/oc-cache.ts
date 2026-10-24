/** Tiny 60s cache for the enriched session list (server-side).
 *  Held on globalThis: Next 15 bundles each route as its own module graph,
 *  so a module-level variable would give /api/session and the watchdog's
 *  graph disconnected caches — busts from the run-event stream would never
 *  reach the list route (same shape as run-events' globalThis registry). */
const g = globalThis as unknown as {
  __ozListCache?: { at: number; data: unknown } | null;
  __ozListGen?: number;
};
const CACHE_MS = 60_000;

export function getCache() {
  const c = g.__ozListCache;
  if (c && Date.now() - c.at < CACHE_MS) return c.data;
  return null;
}

/** Bust generation — read it BEFORE building a list, hand it to setCache. */
export const cacheGen = (): number => g.__ozListGen || 0;

/** A list built across a bust is already stale (it read the brain before the
 *  run ended): never pin it for a minute. The sim triad e2e caught a 7 ms run
 *  whose `working` row outlived it by the whole cache window. */
export function setCache(data: unknown, gen: number) {
  if (gen !== cacheGen()) return;
  g.__ozListCache = { at: Date.now(), data };
}

export function bustCache() {
  g.__ozListCache = null;
  g.__ozListGen = cacheGen() + 1;
}

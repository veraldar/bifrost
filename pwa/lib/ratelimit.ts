/**
 * Per-credential token buckets (S1: rate limits per token). In-process —
 * the middleware runs on the node runtime in the one server process, so a
 * Map is the whole store. Keys: `dev:<deviceId>` (one bucket per device
 * credential lineage, so rotating tokens never resets the limit) and
 * `peer:<ip>` for the unauthenticated pairing surface.
 */
const BURST = Number(process.env.BIFROST_RATE_BURST) || 300;
const PER_SEC = Number(process.env.BIFROST_RATE_PER_SEC) || 5;
const MAX_KEYS = 10_000;

const buckets = new Map<string, { tokens: number; at: number }>();

export function rateTake(
  key: string,
  burst = BURST,
  perSec = PER_SEC,
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSec);
  b.at = now;
  if (buckets.size >= MAX_KEYS && !buckets.has(key)) buckets.clear();
  buckets.set(key, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfter: 0 };
  }
  return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / perSec)) };
}

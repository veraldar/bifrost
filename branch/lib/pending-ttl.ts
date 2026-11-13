/** Shared client/server constant: how long a prompt-with-no-answer still
 *  counts as "awaiting answer". Aborted/failed prompts stay that way forever
 *  without a window. Live runs are exempt (tracked by lib/oc-live). */
export const PENDING_TTL_MS = 10 * 60_000;

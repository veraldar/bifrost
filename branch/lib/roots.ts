/**
 * Join a new machine to this hub's tree (contract v1 — docs/spec-join.md).
 *
 * The joining machine (root/install/join.sh) POSTs a join request and shows
 * the approve URL as a QR plus a human code; the owner scans it with an
 * already-paired phone and approves. Approval:
 *   - assigns a root id (a unique slug of the name — never `local`/`join`,
 *     never an id any device allowlist already names),
 *   - mints link tokens with the trunk's own CLI (`bifrost-net rootlink
 *     mint`, so the capsule format can never drift from the bridge's opener):
 *     dev claim = the approving device, roots claim = [root id],
 *   - creates the root's long-lived credential (only its sha256 is stored, in
 *     the roots registry next to devices.json, mode 600),
 *   - adds the root to the APPROVING device's allowlist in devices.json,
 *   - holds the raw result in this process's memory until the joiner collects
 *     it ONCE with its join secret.
 *
 * At rest: hashes only (join secret, root secret). Raw link tokens and the
 * raw root secret exist only in memory between approval and the one
 * collection, then are dropped. Pending joins are memory-only too: a hub
 * restart forgets them and the machine runs join again.
 *
 * Env: BIFROST_ROOTS_FILE (default: roots.json beside BIFROST_DEVICES_FILE),
 * BIFROST_NET_BIN (default `bifrost-net` on PATH), BIFROST_ROOTLINK_SECRET_FILE
 * or BIFROST_BRIDGE_CONFIG (its `root_link_secret`), BIFROST_ROOTLINK_URL,
 * YGG_PEER_TOKEN, BIFROST_PUBLIC_URL; tuning BIFROST_JOIN_TTL_S (600),
 * BIFROST_JOIN_LIMIT / BIFROST_JOIN_WINDOW_S (5 per 600 s per client address),
 * BIFROST_ROOT_REFILL_LIMIT / BIFROST_ROOT_REFILL_WINDOW_S (6 per 3600 s per root).
 */
import { execFile } from 'child_process';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { chmod, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { addDeviceRoot, allowlistedRoots, listDevices } from '@/lib/devices';
import { clientKey } from '@/lib/region';

const run = promisify(execFile);

const DEVICES_FILE = process.env.BIFROST_DEVICES_FILE || '.devices.json';
export const ROOTS_FILE =
  process.env.BIFROST_ROOTS_FILE || join(dirname(DEVICES_FILE), 'roots.json');
const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
export const JOIN_TTL_S = num(process.env.BIFROST_JOIN_TTL_S, 600);
export const LINK_TOKENS_PER_BATCH = 20;
const JOIN_LIMIT = num(process.env.BIFROST_JOIN_LIMIT, 5);
/** pending joins held at once, all clients together (memory stays bounded) */
const JOIN_MAX_PENDING = num(process.env.BIFROST_JOIN_MAX_PENDING, 32);
const JOIN_WINDOW_MS = num(process.env.BIFROST_JOIN_WINDOW_S, 600) * 1000;
const REFILL_LIMIT = num(process.env.BIFROST_ROOT_REFILL_LIMIT, 6);
const REFILL_WINDOW_MS = num(process.env.BIFROST_ROOT_REFILL_WINDOW_S, 3600) * 1000;
/** ids a joined root can never take: the hub itself, and the route segment */
const RESERVED = new Set(['local', 'join']);

export const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && x.length === y.length && timingSafeEqual(x, y);
}

/* ---------------- memory: pending joins, rate windows, write chain ---------------- */

export type JoinStatus = 'pending' | 'approved' | 'refused' | 'expired' | 'delivered';

export type Approved = {
  root_id: string;
  root_secret: string;
  link_tokens: string[];
  rootlink_url: string;
  peer_token: string;
  hub: 'local';
};

type JoinReq = {
  req: string;
  secretHash: string;
  code: string;
  name: string;
  os: string;
  host: string;
  peer: string;
  created: number;
  exp: number;
  status: 'pending' | 'approved' | 'refused' | 'delivered';
  by?: string;
  root_id?: string;
  /** the raw result — memory only, dropped on collection or at holdUntil */
  result?: Approved;
  holdUntil?: number;
  why?: string;
};

type State = {
  joins: Map<string, JoinReq>;
  windows: Map<string, number[]>;
  chain: Promise<unknown>;
};

// globalThis: every route bundle in this one server process sees ONE store
const g = globalThis as { __bifrostJoin?: State };
const S: State = (g.__bifrostJoin ??= {
  joins: new Map(),
  windows: new Map(),
  chain: Promise.resolve(),
});

/** Sliding-window limit: at most `limit` hits per `windowMs` for `key`. */
export function windowTake(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const hits = (S.windows.get(key) ?? []).filter((t) => t > now - windowMs);
  if (S.windows.size > 10_000 && !S.windows.has(key)) S.windows.clear();
  if (hits.length >= limit) {
    S.windows.set(key, hits);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)) };
  }
  hits.push(now);
  S.windows.set(key, hits);
  return { ok: true, retryAfter: 0 };
}

export const joinLimit = (peer: string) =>
  windowTake(`join:${clientKey(peer) || 'unknown'}`, JOIN_LIMIT, JOIN_WINDOW_MS);
export const refillLimit = (root: string) =>
  windowTake(`refill:${root}`, REFILL_LIMIT, REFILL_WINDOW_MS);

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const out = S.chain.then(fn);
  S.chain = out.catch(() => {});
  return out;
}

function prune() {
  const now = Date.now();
  for (const [k, j] of S.joins) {
    // an undelivered approval is dropped after its hold window (raw secrets
    // never outlive it); every record lingers an hour so a late poll gets an
    // honest 410 instead of a 404
    if (j.result && j.holdUntil && j.holdUntil < now) {
      j.result = undefined;
      j.why = 'undelivered';
    }
    if (Math.max(j.exp, j.holdUntil ?? 0) < now - 3600_000) S.joins.delete(k);
  }
}

/* ---------------- the roots registry (hashes only, mode 600) ---------------- */

export type RootRecord = {
  id: string;
  name: string;
  os: string;
  host: string;
  joined_at: string;
  /** the device that approved it — the dev claim of every link token */
  dev: string;
  secretHash: string;
  /** when the machine collected its credentials (null: never collected) */
  delivered_at: string | null;
};

type RootsFile = { version: 1; roots: RootRecord[] };

async function readRoots(): Promise<RootsFile> {
  try {
    const parsed = JSON.parse(await readFile(ROOTS_FILE, 'utf8'));
    return { version: 1, roots: Array.isArray(parsed.roots) ? parsed.roots : [] };
  } catch {
    return { version: 1, roots: [] };
  }
}

async function writeRoots(f: RootsFile): Promise<void> {
  const tmp = `${ROOTS_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, ROOTS_FILE);
}

export async function listRoots() {
  const f = await readRoots();
  return f.roots.map(({ id, name, os, host, joined_at, delivered_at }) => ({
    id,
    name,
    os,
    host,
    joined_at,
    delivered_at: delivered_at ?? null,
  }));
}

export function rootIdFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'root';
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!RESERVED.has(id) && !taken.has(id)) return id;
  }
}

/* ---------------- minting: the trunk's own CLI ---------------- */

async function rootLinkSecret(): Promise<string> {
  const file = process.env.BIFROST_ROOTLINK_SECRET_FILE;
  if (file) return (await readFile(file, 'utf8')).trim();
  const cfg = process.env.BIFROST_BRIDGE_CONFIG;
  if (cfg) {
    const toml = await readFile(cfg, 'utf8');
    const m = toml.match(/^\s*root_link_secret\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/m);
    return (m?.[1] ?? m?.[2] ?? '').trim();
  }
  return '';
}

export class MintError extends Error {}

/** `n` single-use link tokens for `root`, dev claim `dev`, roots claim [root]. */
export async function mintLinkTokens(root: string, dev: string, n: number): Promise<string[]> {
  const bin = process.env.BIFROST_NET_BIN || 'bifrost-net';
  let secret = '';
  try {
    secret = await rootLinkSecret();
  } catch (e) {
    throw new MintError(`root-link secret unreadable: ${(e as Error).message}`);
  }
  if (!secret) {
    throw new MintError(
      'root-link minting is not configured: set BIFROST_ROOTLINK_SECRET_FILE or BIFROST_BRIDGE_CONFIG (root_link_secret)'
    );
  }
  const one = async () => {
    // execFile, no shell: no argument is ever interpreted
    const { stdout } = await run(
      bin,
      ['rootlink', 'mint', '--root', root, '--dev', dev, '--roots', root, '--secret', secret],
      // the child needs nothing from this process's env (no secret rides it)
      {
        timeout: 10_000,
        encoding: 'utf8',
        env: { PATH: process.env.PATH || '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv,
      }
    );
    const t = stdout.trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) throw new Error('unexpected mint output');
    return t;
  };
  const out: string[] = [];
  try {
    for (let i = 0; i < n; i += 5) {
      out.push(...(await Promise.all(Array.from({ length: Math.min(5, n - i) }, one))));
    }
  } catch (e) {
    throw new MintError(`${bin} rootlink mint failed: ${(e as Error).message.split('\n')[0]}`);
  }
  if (new Set(out).size !== out.length) throw new MintError('mint returned a duplicate token');
  return out;
}

/* ---------------- the join flow ---------------- */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
function humanCode(): string {
  const c = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${c.slice(0, 4).join('')}-${c.slice(4).join('')}`;
}

/** printable, single-line, bounded — these strings are shown to the owner */
const invisible = (c: number) =>
  c < 0x20 ||
  (c >= 0x7f && c <= 0x9f) ||
  (c >= 0x200b && c <= 0x200f) || // zero-width
  (c >= 0x202a && c <= 0x202e) || // bidi overrides
  (c >= 0x2066 && c <= 0x2069);
export function clean(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : '';
  return Array.from(s.replace(/\s+/g, ' '))
    .filter((ch) => !invisible(ch.codePointAt(0) ?? 0))
    .join('')
    .trim()
    .slice(0, max);
}

export function createJoin(input: { name: string; os: string; host: string }, peer: string) {
  prune();
  const now0 = Date.now();
  let pending = 0;
  for (const j of S.joins.values()) if (j.status === 'pending' && j.exp > now0) pending += 1;
  if (pending >= JOIN_MAX_PENDING) return null;
  const req = randomBytes(18).toString('base64url');
  const secret = randomBytes(16).toString('hex');
  const now = Date.now();
  const j: JoinReq = {
    req,
    secretHash: sha256(secret),
    code: humanCode(),
    name: input.name,
    os: input.os,
    host: input.host,
    peer,
    created: now,
    exp: now + JOIN_TTL_S * 1000,
    status: 'pending',
  };
  S.joins.set(req, j);
  return { req, secret, code: j.code, expires_in: JOIN_TTL_S };
}

function statusOf(j: JoinReq): JoinStatus {
  if (j.status === 'pending' && j.exp < Date.now()) return 'expired';
  if (j.status === 'approved' && !j.result) return 'expired';
  return j.status;
}

/** What the approving phone sees (no secrets). */
export function viewJoin(req: string) {
  prune();
  const j = S.joins.get(req);
  if (!j) return null;
  return {
    req: j.req,
    name: j.name,
    os: j.os,
    host: j.host,
    code: j.code,
    status: statusOf(j),
    expires_at: new Date(j.exp).toISOString(),
    root_id: j.root_id ?? null,
  };
}

export type PollOut =
  | { http: 404 | 401; body: { error: string } }
  | { http: 202; body: { status: 'pending' } }
  | { http: 410; body: { status: 'refused' | 'expired'; why?: string } }
  | { http: 200; body: { status: 'approved' } & Approved };

/** The joiner's poll: its join secret, the result ONCE, then 410. */
export function pollJoin(req: string, secret: string): Promise<PollOut> {
  return serialize(async () => {
    prune();
    const j = S.joins.get(req);
    if (!j) return { http: 404, body: { error: 'unknown join request' } };
    if (!/^[0-9a-f]{32}$/.test(secret) || !sameHash(sha256(secret), j.secretHash)) {
      return { http: 401, body: { error: 'bad join secret' } };
    }
    const st = statusOf(j);
    if (st === 'pending') return { http: 202, body: { status: 'pending' } };
    if (st === 'refused') return { http: 410, body: { status: 'refused' } };
    if (st === 'delivered') return { http: 410, body: { status: 'expired', why: 'delivered' } };
    if (st === 'expired' || !j.result) {
      return { http: 410, body: { status: 'expired', ...(j.why ? { why: j.why } : {}) } };
    }
    const result = j.result;
    j.result = undefined; // ONCE: the raw secrets leave memory with this response
    j.status = 'delivered';
    const f = await readRoots();
    const rec = f.roots.find((r) => r.id === result.root_id);
    if (rec) {
      rec.delivered_at = new Date().toISOString();
      await writeRoots(f);
    }
    return { http: 200, body: { status: 'approved', ...result } };
  });
}

export type Decision =
  | { http: 200; body: Record<string, unknown> }
  | { http: 404 | 409 | 410 | 502 | 503; body: { error: string; status?: JoinStatus } };

export function refuseJoin(req: string, device: string): Promise<Decision> {
  return serialize(async () => {
    prune();
    const j = S.joins.get(req);
    if (!j) return { http: 404, body: { error: 'unknown join request' } };
    const st = statusOf(j);
    if (st === 'expired') return { http: 410, body: { error: 'join request expired', status: st } };
    if (st !== 'pending') return { http: 409, body: { error: `already ${st}`, status: st } };
    j.status = 'refused';
    j.by = device;
    return { http: 200, body: { status: 'refused' } };
  });
}

export function approveJoin(req: string, device: string): Promise<Decision> {
  return serialize(async () => {
    prune();
    const j = S.joins.get(req);
    if (!j) return { http: 404, body: { error: 'unknown join request' } };
    const st = statusOf(j);
    if (st === 'expired') return { http: 410, body: { error: 'join request expired', status: st } };
    if (st !== 'pending') return { http: 409, body: { error: `already ${st}`, status: st } };

    const f = await readRoots();
    const taken = new Set([...f.roots.map((r) => r.id), ...(await allowlistedRoots())]);
    const root_id = rootIdFor(j.name || j.host, taken);

    // mint first: it has no side effects, so a misconfigured hub leaves the
    // request pending and the owner can approve again once it is fixed
    let link_tokens: string[];
    try {
      link_tokens = await mintLinkTokens(root_id, device, LINK_TOKENS_PER_BATCH);
    } catch (e) {
      const msg = e instanceof MintError ? e.message : 'link-token mint failed';
      console.error(`join ${req}: ${msg}`);
      return { http: 503, body: { error: msg } };
    }

    const root_secret = randomBytes(16).toString('hex');
    const now = new Date();
    f.roots.push({
      id: root_id,
      name: j.name,
      os: j.os,
      host: j.host,
      joined_at: now.toISOString(),
      dev: device,
      secretHash: sha256(root_secret),
      delivered_at: null,
    });
    await writeRoots(f);
    if (!(await addDeviceRoot(device, root_id))) {
      // the approving device went away between the gate and here: undo
      f.roots = f.roots.filter((r) => r.id !== root_id);
      await writeRoots(f);
      return { http: 409, body: { error: 'approving device is no longer live' } };
    }

    j.status = 'approved';
    j.by = device;
    j.root_id = root_id;
    j.holdUntil = Date.now() + JOIN_TTL_S * 1000;
    j.result = {
      root_id,
      root_secret,
      link_tokens,
      rootlink_url: process.env.BIFROST_ROOTLINK_URL || '',
      peer_token: process.env.YGG_PEER_TOKEN || '',
      hub: 'local',
    };
    return {
      http: 200,
      body: { status: 'approved', root_id, name: j.name, os: j.os, host: j.host },
    };
  });
}

/** POST /api/roots/<id>/tokens — the root's own credential buys 20 more. */
export async function refillTokens(
  root: string,
  secret: string
): Promise<
  | { http: 200; body: { link_tokens: string[] } }
  | { http: 401 | 409 | 429 | 503; body: { error: string; why?: string }; retryAfter?: number }
> {
  const f = await readRoots();
  const rec = f.roots.find((r) => r.id === root);
  if (!rec || !/^[0-9a-f]{32}$/.test(secret) || !sameHash(sha256(secret), rec.secretHash)) {
    return { http: 401, body: { error: 'unknown root or bad root secret' } };
  }
  // the bridge refuses a link token whose dev claim is revoked: say so here
  // instead of handing out 20 tokens that can never open
  const approver = (await listDevices()).devices.find((d) => d.id === rec.dev);
  if (!approver || approver.revoked) {
    return {
      http: 409,
      body: {
        error: 'the device that approved this root was revoked — join again',
        why: 'device-revoked',
      },
    };
  }
  // counted only once authenticated: a stranger who knows the id cannot
  // drain the root's own refill budget
  const rl = refillLimit(root);
  if (!rl.ok) return { http: 429, body: { error: 'rate limited' }, retryAfter: rl.retryAfter };
  try {
    return {
      http: 200,
      body: { link_tokens: await mintLinkTokens(root, rec.dev, LINK_TOKENS_PER_BATCH) },
    };
  } catch (e) {
    const msg = e instanceof MintError ? e.message : 'link-token mint failed';
    console.error(`refill ${root}: ${msg}`);
    return { http: 503, body: { error: msg } };
  }
}

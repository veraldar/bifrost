/**
 * Device registry — the S1 auth seam (v0.9 no-tailscale), full semantics.
 *
 * ONE json file (default `pwa/.devices.json`, chmod 600, gitignored) shared
 * with the bifrost-net bridge: the PWA mints / rotates / revokes, the bridge
 * only verifies. At rest there are ONLY sha256 hashes — a raw credential
 * leaves this process once (claim / refresh / mint response) and is never
 * written. sha256 is the right primitive here: every credential is 128-256
 * bits of CSPRNG output (slow KDFs exist for low-entropy passwords).
 *
 * Credentials:
 *   bfnp-…  pairing code   one-time, PAIR_TTL (5 min), admin-minted, in the QR
 *   bfnd-…  access token   ACCESS_TTL (15 min), bound to the network region it
 *                          was issued in (lib/region.ts)
 *   bfnr-…  refresh token  REFRESH_TTL (30 d), rotated on every use; a rotated
 *                          token presented again after ROTATE_GRACE = theft
 *                          signal → the whole device is revoked
 *
 * Kill switch: killEpoch++ + every device revoked + every pairing code burned.
 * The bridge watches the epoch and drops ALL live peers ("sever all bridges").
 *
 * v1 entries (non-expiring `tokenHash`, no region) carry no v2 credential and
 * read as revoked — the device re-pairs once.
 */
import { createHash, randomBytes } from 'crypto';
import { chmod, readFile, rename, writeFile } from 'fs/promises';

const DEVICES_FILE = process.env.BIFROST_DEVICES_FILE || '.devices.json';
const secs = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d) * 1000;
export const ACCESS_TTL_MS = secs(process.env.BIFROST_ACCESS_TTL_S, 15 * 60);
export const REFRESH_TTL_MS = secs(process.env.BIFROST_REFRESH_TTL_S, 30 * 86400);
export const PAIR_TTL_MS = secs(process.env.BIFROST_PAIR_TTL_S, 5 * 60);
// two tabs refreshing at once is a race, not a theft
const ROTATE_GRACE_MS = secs(process.env.BIFROST_ROTATE_GRACE_S, 30);
// refresh (default): a region change needs the refresh credential (re-auth);
// repair: a region change needs a fresh QR scan
const REGION_POLICY = process.env.BIFROST_REGION_POLICY === 'repair' ? 'repair' : 'refresh';

type Access = { hash: string; exp: number; region: string };

export type Device = {
  id: string;
  name: string;
  created: string;
  revoked: boolean;
  revokedAt?: string;
  revokedWhy?: string;
  /** first-seen network region (bound at claim) */
  region: string;
  lastRegion: string;
  regionChanges: number;
  lastSeen: string;
  refreshHash: string;
  refreshExp: number;
  prevRefresh: Array<{ hash: string; at: number }>;
  access: Access[];
};

type PairCode = { hash: string; exp: number; name: string; created: string; used?: string };

type Registry = {
  version: 2;
  killEpoch: number;
  killedAt?: string;
  devices: Device[];
  codes: PairCode[];
};

export type Issued = {
  id: string;
  name: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type Deny = 'missing' | 'invalid' | 'expired' | 'revoked' | 'region' | 'used' | 'reuse';

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw.trim()).digest('hex');
}

const secret = (prefix: string, bytes: number) =>
  `${prefix}${randomBytes(bytes).toString('base64url')}`;

function upgrade(d: Partial<Device> & { tokenHash?: string }): Device {
  const v2 = typeof d.refreshHash === 'string';
  return {
    id: String(d.id || `dev_${randomBytes(4).toString('hex')}`),
    name: String(d.name || 'device'),
    created: String(d.created || new Date(0).toISOString()),
    revoked: v2 ? Boolean(d.revoked) : true,
    revokedAt: d.revokedAt,
    revokedWhy: v2 ? d.revokedWhy : 'v1 token (no expiry/region) — re-pair',
    region: String(d.region || 'unknown'),
    lastRegion: String(d.lastRegion || d.region || 'unknown'),
    regionChanges: Number(d.regionChanges) || 0,
    lastSeen: String(d.lastSeen || ''),
    refreshHash: v2 ? String(d.refreshHash) : '',
    refreshExp: Number(d.refreshExp) || 0,
    prevRefresh: Array.isArray(d.prevRefresh) ? d.prevRefresh : [],
    access: Array.isArray(d.access) ? d.access : [],
  };
}

async function readRegistry(): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(DEVICES_FILE, 'utf8'));
    return {
      version: 2,
      killEpoch: Number(parsed.killEpoch) || 0,
      killedAt: parsed.killedAt,
      devices: (Array.isArray(parsed.devices) ? parsed.devices : []).map(upgrade),
      codes: Array.isArray(parsed.codes) ? parsed.codes : [],
    };
  } catch {
    return { version: 2, killEpoch: 0, devices: [], codes: [] };
  }
}

async function writeRegistry(reg: Registry): Promise<void> {
  const tmp = `${DEVICES_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, DEVICES_FILE); // atomic: the bridge never reads a torn file
}

function prune(reg: Registry) {
  const now = Date.now();
  for (const d of reg.devices) {
    d.access = d.access.filter((a) => a.exp > now);
    d.prevRefresh = d.prevRefresh.slice(-8);
  }
  // spent/expired codes linger an hour so a replay gets an honest "used"
  reg.codes = reg.codes.filter((c) => c.exp > now - 3600_000);
}

// one writer process; serialize read-modify-write so concurrent refreshes
// cannot lose each other's rotation
let chain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (reg: Registry) => T): Promise<T> {
  const run = chain.then(async () => {
    const reg = await readRegistry();
    const out = fn(reg);
    prune(reg);
    await writeRegistry(reg);
    return out;
  });
  chain = run.catch(() => {});
  return run;
}

function newDevice(reg: Registry, name: string, region: string): Device {
  const d = upgrade({
    id: `dev_${randomBytes(4).toString('hex')}`,
    name: String(name || 'device').slice(0, 40),
    created: new Date().toISOString(),
    revoked: false,
    region,
    refreshHash: '',
  });
  reg.devices.push(d);
  return d;
}

function issue(d: Device, region: string): Issued {
  const now = Date.now();
  const accessToken = secret('bfnd-', 24);
  const refreshToken = secret('bfnr-', 32);
  d.access.push({ hash: hashToken(accessToken), exp: now + ACCESS_TTL_MS, region });
  if (d.refreshHash) d.prevRefresh.push({ hash: d.refreshHash, at: now });
  d.refreshHash = hashToken(refreshToken);
  d.refreshExp = now + REFRESH_TTL_MS;
  d.lastSeen = new Date(now).toISOString();
  if (region !== d.lastRegion) {
    d.regionChanges += 1;
    d.lastRegion = region;
  }
  return {
    id: d.id,
    name: d.name,
    accessToken,
    refreshToken,
    expiresIn: Math.round(ACCESS_TTL_MS / 1000),
  };
}

function revokeIn(d: Device, why: string) {
  if (d.revoked) return;
  d.revoked = true;
  d.revokedAt = new Date().toISOString();
  d.revokedWhy = why;
}

/** Admin direct mint (CLI / headless devices): returns the credentials ONCE. */
export function mintDevice(name: string, region: string): Promise<Issued> {
  return mutate((reg) => issue(newDevice(reg, name, region), region));
}

/** Admin: one-time pairing code for the QR. */
export async function mintPairCode(name = 'phone'): Promise<{ code: string; exp: number }> {
  const code = secret('bfnp-', 16);
  const exp = Date.now() + PAIR_TTL_MS;
  await mutate((reg) => {
    reg.codes.push({
      hash: hashToken(code),
      exp,
      name: String(name).slice(0, 40),
      created: new Date().toISOString(),
    });
  });
  return { code, exp };
}

/**
 * Phone: redeem a pairing code. Single use (replay → 'used'), expiring
 * ('expired'). `prevRefresh` = the phone's old refresh credential, if it still
 * holds one: revoke-on-repair retires the device it belonged to.
 */
export function claimPairCode(
  code: string,
  name: string,
  region: string,
  prevRefresh?: string,
): Promise<({ ok: true } & Issued) | { ok: false; why: Deny }> {
  return mutate((reg) => {
    const c = reg.codes.find((x) => x.hash === hashToken(code || ''));
    if (!c || (code || '').length < 16) return { ok: false as const, why: 'invalid' as Deny };
    if (c.used) return { ok: false as const, why: 'used' as Deny };
    if (c.exp < Date.now()) return { ok: false as const, why: 'expired' as Deny };
    if (prevRefresh) {
      const h = hashToken(prevRefresh);
      const old = reg.devices.find((d) => d.refreshHash === h);
      if (old) revokeIn(old, 're-paired');
    }
    const d = newDevice(reg, name || c.name, region);
    c.used = d.id;
    return { ok: true as const, ...issue(d, region) };
  });
}

/** Rotate: old refresh dies, new access is bound to the CURRENT region. */
export function refreshDevice(
  raw: string,
  region: string,
): Promise<({ ok: true; regionChanged: boolean } & Issued) | { ok: false; why: Deny }> {
  return mutate((reg) => {
    const deny = (why: Deny) => ({ ok: false as const, why });
    if (!raw || raw.length < 16) return deny('missing');
    const h = hashToken(raw);
    const now = Date.now();
    let d = reg.devices.find((x) => x.refreshHash === h);
    if (!d) {
      const stale = reg.devices.find((x) => x.prevRefresh.some((p) => p.hash === h));
      if (!stale) return deny('invalid');
      if (stale.revoked) return deny('revoked');
      const at = stale.prevRefresh.find((p) => p.hash === h)!.at;
      if (now - at > ROTATE_GRACE_MS) {
        revokeIn(stale, 'refresh token replayed (theft signal)');
        return deny('reuse');
      }
      d = stale; // benign race: rotate again, the newest cookie wins
    }
    if (d.revoked) return deny('revoked');
    if (d.refreshExp < now) return deny('expired');
    if (REGION_POLICY === 'repair' && region !== d.region) return deny('region');
    const regionChanged = region !== d.lastRegion;
    return { ok: true as const, regionChanged, ...issue(d, region) };
  });
}

/** The gate: a live, unexpired access token issued in THIS region. */
export async function checkAccess(
  raw: string,
  region: string,
): Promise<{ ok: true; device: Device } | { ok: false; why: Deny }> {
  if (!raw || raw.length < 16) return { ok: false, why: 'missing' };
  const reg = await readRegistry();
  const h = hashToken(raw);
  for (const d of reg.devices) {
    const a = d.access.find((x) => x.hash === h);
    if (!a) continue;
    if (d.revoked) return { ok: false, why: 'revoked' };
    if (a.exp < Date.now()) return { ok: false, why: 'expired' };
    if (a.region !== region) return { ok: false, why: 'region' };
    return { ok: true, device: d };
  }
  return { ok: false, why: 'invalid' };
}

export type DeviceView = Omit<Device, 'refreshHash' | 'prevRefresh' | 'access' | 'refreshExp'> & {
  liveTokens: number;
};

export async function listDevices(): Promise<{
  devices: DeviceView[];
  killEpoch: number;
  killedAt?: string;
}> {
  const reg = await readRegistry();
  const now = Date.now();
  return {
    killEpoch: reg.killEpoch,
    killedAt: reg.killedAt,
    devices: reg.devices.map(
      ({ refreshHash: _r, prevRefresh: _p, refreshExp: _e, access, ...rest }) => ({
        ...rest,
        liveTokens: rest.revoked ? 0 : access.filter((a) => a.exp > now).length,
      }),
    ),
  };
}

export function revokeDevice(id: string, why = 'revoked from the device list'): Promise<boolean> {
  return mutate((reg) => {
    const d = reg.devices.find((x) => x.id === id);
    if (!d) return false;
    revokeIn(d, why);
    return true;
  });
}

/** KILL-SWITCH — sever all bridges: every device, every code, every live peer. */
export function killSwitch(): Promise<{ epoch: number; severed: number }> {
  return mutate((reg) => {
    let severed = 0;
    for (const d of reg.devices) {
      if (!d.revoked) severed += 1;
      revokeIn(d, 'kill-switch');
    }
    reg.codes = [];
    reg.killEpoch += 1;
    reg.killedAt = new Date().toISOString();
    return { epoch: reg.killEpoch, severed };
  });
}

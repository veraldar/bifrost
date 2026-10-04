/**
 * Device registry — the S1 auth seam (v0.9 no-tailscale).
 *
 * The source of truth is ONE json file (default `pwa/.devices.json`, chmod
 * 600, gitignored) shared with the bifrost-net bridge: the PWA mints and
 * revokes, the bridge only verifies sha256 hashes. Raw tokens are returned
 * exactly once at pairing and never stored.
 *
 * Shape: { devices: [{ id, name, tokenHash, created, revoked }] }
 */
import { createHash, randomBytes } from 'crypto';
import { readFile, writeFile, chmod } from 'fs/promises';

const DEVICES_FILE = process.env.BIFROST_DEVICES_FILE || '.devices.json';

export type Device = {
  id: string;
  name: string;
  tokenHash: string;
  created: string;
  revoked: boolean;
};

type Registry = { devices: Device[] };

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw.trim()).digest('hex');
}

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(DEVICES_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Registry;
    return { devices: Array.isArray(parsed.devices) ? parsed.devices : [] };
  } catch {
    return { devices: [] };
  }
}

async function writeRegistry(reg: Registry): Promise<void> {
  await writeFile(DEVICES_FILE, JSON.stringify(reg, null, 2) + '\n');
  await chmod(DEVICES_FILE, 0o600).catch(() => {});
}

/** Mint one device: returns the raw token ONCE. */
export async function mintDevice(name: string): Promise<{ id: string; token: string }> {
  const reg = await readRegistry();
  const id = `dev_${randomBytes(4).toString('hex')}`;
  const token = `bfnd-${randomBytes(24).toString('base64url')}`;
  reg.devices.push({
    id,
    name: String(name || 'device').slice(0, 40),
    tokenHash: hashToken(token),
    created: new Date().toISOString(),
    revoked: false,
  });
  await writeRegistry(reg);
  return { id, token };
}

export async function listDevices(): Promise<Array<Omit<Device, 'tokenHash'>>> {
  const reg = await readRegistry();
  return reg.devices.map(({ tokenHash: _hash, ...rest }) => rest);
}

export async function revokeDevice(id: string): Promise<boolean> {
  const reg = await readRegistry();
  const hit = reg.devices.find((d) => d.id === id);
  if (!hit) return false;
  hit.revoked = true;
  await writeRegistry(reg);
  return true;
}

/** Validate a raw bearer token against the live registry. */
export async function validateToken(raw: string): Promise<boolean> {
  if (!raw || raw.length < 16) return false;
  const reg = await readRegistry();
  const hash = hashToken(raw);
  return reg.devices.some((d) => d.tokenHash === hash && !d.revoked);
}

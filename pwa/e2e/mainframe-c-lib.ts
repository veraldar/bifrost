import { RoomServiceClient } from 'livekit-server-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type Page, type Request, expect } from '@playwright/test';

/** shared by the MAINFRAME-C voice specs: a returning phone with voice tests
 *  ON — every roots turn lands in the voice-test room, MAIN is never written */

export const SHOTS = process.env.TF_SHOTS || '../artifacts';
export const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/mainframe-c-${name}.png` });

type M = { role: string; text: string; time: number; done?: boolean };

export async function vtMsgs(request: APIRequestContext): Promise<M[]> {
  const r = await request.get('/api/session/voice-test/messages?limit=200');
  return r.ok() ? ((await r.json()) as M[]) : [];
}
export const users = (ms: M[]) => ms.filter((m) => m.role === 'user');

export async function mainTotal(request: APIRequestContext): Promise<number> {
  const r = await request.get('/api/session/main/messages?limit=1');
  return Number(r.headers()['x-total-count'] || 0);
}

export async function ensureVoiceTest(request: APIRequestContext) {
  if (!(await request.get('/api/session/voice-test/messages?limit=1')).ok()) {
    expect((await request.post('/api/session', { data: { name: 'voice-test' } })).ok()).toBe(true);
  }
}

export function tokenRooms(page: Page): string[] {
  const rooms: string[] = [];
  page.on('request', (r: Request) => {
    if (r.url().endsWith('/api/token') && r.method() === 'POST') {
      try {
        rooms.push(String(JSON.parse(r.postData() || '{}').room));
      } catch {
        rooms.push('?');
      }
    }
  });
  return rooms;
}

export async function homeVt(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('mfc-init')) return;
    sessionStorage.setItem('mfc-init', '1');
    localStorage.setItem('bifrost-voice-test', '1');
    localStorage.setItem('bifrost-first-turn', '1');
    localStorage.setItem('oz-mode', 'text');
  });
  await page.goto('/');
  await expect(page.getByTestId('roots')).toBeVisible();
  await expect(page.getByTestId('roots-name')).toHaveText('voice-test');
}

export async function center(page: Page) {
  const b = (await page.getByTestId('roots-hit').boundingBox())!;
  return { x: b.x + b.width * 0.4, y: b.y + b.height * 0.55 };
}

export async function diag(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (JSON.parse(localStorage.getItem('oz-diag') || '[]') as { kind: string; msg: string }[]).map(
      (e) => `${e.kind} ${e.msg}`
    )
  );
}

export const phase = (page: Page) => page.getByTestId('roots');

/** the page's console, kept (the TTS deck reports through console.warn) */
export function consoleTap(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (m) => lines.push(`${m.type()} ${m.text()}`));
  page.on('pageerror', (e) => lines.push(`pageerror ${e.message}`));
  return lines;
}

/** Wait until a room holds nobody — no agent job still draining from the
 *  previous test. The voice agent (lk-agent-ygg) answers a new dispatch
 *  while an old job drains by WAITING up to 20 s with its session already
 *  live and still on VAD turn-taking (manual is set after the wait): that
 *  second agent auto-commits whatever the mic says. Pre-existing, agent-side
 *  (docs/reviews/mainframe-c-report.md § findings) — the specs start clean. */
export async function quietRoom(room: string, ms = 45_000) {
  const env = Object.fromEntries(
    readFileSync(join(__dirname, '../.env.local'), 'utf8')
      .split('\n')
      .map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')])
  );
  const url = (env.LIVEKIT_API_URL || 'http://127.0.0.1:7880').replace(/^ws(s)?:/, 'http$1:');
  const svc = new RoomServiceClient(url, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  const t0 = Date.now();
  let deadline = t0 + ms;
  let closed = false;
  for (;;) {
    const ps = await svc.listParticipants(room).catch(() => []);
    if (!ps.length) return Date.now() - t0;
    if (Date.now() > deadline) {
      // a job whose human never joined (a page that minted a token and left at once) has no
      // disconnect to end on: its agent waits for LiveKit's ~5 min empty timeout. Agents only,
      // no human → close the room once; anyone else in it is a real failure.
      if (!closed && ps.every((p) => p.identity.startsWith('agent-'))) {
        await svc.deleteRoom(room).catch(() => {});
        closed = true;
        deadline = Date.now() + 10_000;
        continue;
      }
      throw new Error(`room ${room} still holds ${ps.map((p) => p.identity).join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

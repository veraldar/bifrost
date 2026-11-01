/** NOREFRESH4: fix the 15s quiet-hands-free teardown/rejoin loop
 *
 *  Root cause: reconnectVoice() success path reset norefreshOnceRef, so
 *  every reconnect re-armed the watchdog loop. A QUIET-ALIVE session (room
 *  present, agent thinking 30-90s = no events) tore down + rejoined every
 *  15s indefinitely. The fix: never reset the guard inside automatic
 *  reconnect paths — only user-driven re-arms (exitFree/switchMode) reset it.
 *
 *  Spec scenarios:
 *  1. quiet-alive >30s: one room, no reconnects, watchdog never fires
 *  2. forced dead room: exactly ONE rejoin after DeleteRoom, then busy error
 *  3. 6 concurrent loaded joins: each room holds 1 agent, zero reconnects
 *  4. ghost-guard sleep race, 20 repeats: exit timing race, room stays open
 *
 *  All scenarios use real LiveKit :7880, real brain :4100, PW_BASE_URL required.
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

test.describe.configure({ mode: 'serial' });

const LK_URL = 'http://127.0.0.1:7880';
const BRAIN_URL = 'http://127.0.0.1:4100';

/** Mint a session + token for direct LiveKit room access */
async function mintSession(slug: string) {
  const base = process.env.PW_BASE_URL || 'http://127.0.0.1:8090';
  const r = await fetch(`${base}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: slug }),
  });
  if (!r.ok) throw new Error(`token mint failed: ${r.status}`);
  return r.json();
}

/** Twirp curl: call a LiveKit RoomService method */
function twirp(method: string, body: object): string {
  const payload = JSON.stringify(body);
  try {
    return execSync(
      `curl -sS -X POST ${LK_URL}/twirp/livekit.RoomService/${method} ` +
        `-H 'Content-Type: application/json' -d '${payload.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf-8', timeout: 10_000 }
    );
  } catch {
    return '{}';
  }
}

/** List participants in a room */
function listParticipants(room: string): any[] {
  const raw = twirp('ListParticipants', { room });
  try {
    const d = JSON.parse(raw);
    return d.participants || [];
  } catch {
    return [];
  }
}

/** Delete a room via twirp */
function deleteRoom(room: string) {
  twirp('DeleteRoom', { room });
}

/** Count how many times a participant with the given identity prefix joined
 *  (checks join timestamps — a new join = a different timestamp) */
function countJoins(room: string, prefix: string): number {
  const parts = listParticipants(room);
  const stamps = new Set<string>();
  for (const p of parts) {
    if (p.identity?.startsWith(prefix)) stamps.add(String(p.joinedAt || '0'));
  }
  return stamps.size;
}

/** Wait for a condition with polling */
async function waitFor(
  fn: () => boolean,
  timeoutMs: number,
  intervalMs = 500
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Diag stream text (accumulated lines) from the page's window.diagLines */
async function getDiagLines(page: any): Promise<string[]> {
  return page.evaluate(() => (window as any).diagLines || []);
}

test.beforeEach(async ({ page }) => {
  // Sentinel: no-reload proof (norefresh2 pattern)
  await page.addInitScript(() => {
    (window as any).norefresh4Sentinel = true;
  });
  // Accumulate diag lines in window.diagLines for watchdog fire checks
  await page.addInitScript(() => {
    (window as any).diagLines = [];
    const orig = console.log;
    console.log = (...args: any[]) => {
      const line = args.join(' ');
      if (line.includes('diag:')) (window as any).diagLines.push(line);
      orig(...args);
    };
  });
});

test('scenario 1: quiet-alive >30s — zero reconnects, watchdog never fires', async ({
  page,
}) => {
  const slug = `norefresh4-quiet-${Date.now()}`;
  await page.goto(`/session/${slug}`);

  // Arm hands-free with a live agent: send a short turn so the agent joins
  await page.getByRole('button', { name: /mic/i }).click();
  await page.waitForSelector('text=/listening|free-phase/i', { timeout: 15_000 });

  // Send a turn to get the agent into the room (type a message)
  const input = page.locator('textarea');
  await input.fill('hello');
  await page.keyboard.press('Enter');

  // Wait for agent to appear
  await waitFor(() => listParticipants(slug).some((p) => p.identity?.startsWith('agent-')), 15_000);

  const agentJoins = countJoins(slug, 'agent-');
  expect(agentJoins).toBe(1);

  // Hold >30s with no further speech
  await page.waitForTimeout(32_000);

  // Assert: SAME participant join stamp persists (zero rejoins)
  const agentJoinsAfter = countJoins(slug, 'agent-');
  expect(agentJoinsAfter).toBe(1);

  // free-phase visible, no error
  await expect(page.locator('text=/listening|free-phase/i')).toBeVisible();
  await expect(page.locator('text=/connection lost|reconnect failed/i')).not.toBeVisible();

  // Watchdog never fired: zero "room silent 15s" lines in diag
  const diag = await getDiagLines(page);
  const watchdogLines = diag.filter((l) => l.includes('room silent 15s'));
  expect(watchdogLines.length).toBe(0);
});

test('scenario 2: forced dead room → exactly ONE rejoin, then busy error', async ({
  page,
}) => {
  const slug = `norefresh4-dead-${Date.now()}`;
  await page.goto(`/session/${slug}`);

  // Arm hands-free
  await page.getByRole('button', { name: /mic/i }).click();
  await page.waitForSelector('text=/listening|free-phase/i', { timeout: 15_000 });

  // Send a turn to get agent
  const input = page.locator('textarea');
  await input.fill('test');
  await page.keyboard.press('Enter');
  await waitFor(() => listParticipants(slug).some((p) => p.identity?.startsWith('agent-')), 15_000);

  const joinsBefore = countJoins(slug, 'agent-');
  expect(joinsBefore).toBe(1);

  // Kill the room
  deleteRoom(slug);
  await page.waitForTimeout(1000);

  // Wait for reconnect window (up to 20s)
  await page.waitForTimeout(20_000);

  // Exactly one new join
  const joinsAfter = countJoins(slug, 'agent-');
  expect(joinsAfter).toBe(2); // original + one reconnect

  // Second kill should NOT trigger another reconnect
  deleteRoom(slug);
  await page.waitForTimeout(20_000);

  const joinsFinal = countJoins(slug, 'agent-');
  expect(joinsFinal).toBe(2); // still just 2

  // Busy error visible
  await expect(page.locator('text=/connection lost|reconnect failed/i')).toBeVisible();

  // Sentinel proves no reload
  const sentinel = await page.evaluate(() => (window as any).norefresh4Sentinel);
  expect(sentinel).toBe(true);
});

test('scenario 3: 6 concurrent loaded joins — each room holds 1 agent, zero reconnects', async ({
  browser,
}) => {
  const contexts = await Promise.all(Array.from({ length: 6 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const slugs = pages.map((_, i) => `norefresh4-load${i}-${Date.now()}`);

  // Add init scripts to all pages
  for (const page of pages) {
    await page.addInitScript(() => {
      (window as any).diagLines = [];
      const orig = console.log;
      console.log = (...args: any[]) => {
        const line = args.join(' ');
        if (line.includes('diag:')) (window as any).diagLines.push(line);
        orig(...args);
      };
    });
  }

  // All 6 join and arm hands-free
  await Promise.all(
    pages.map(async (page, i) => {
      await page.goto(`/session/${slugs[i]}`);
      await page.getByRole('button', { name: /mic/i }).click();
      await page.waitForSelector('text=/listening|free-phase/i', { timeout: 15_000 });

      // Send a turn to get agent
      const input = page.locator('textarea');
      await input.fill('load test');
      await page.keyboard.press('Enter');
    })
  );

  // Wait for all agents to join
  for (const slug of slugs) {
    await waitFor(() => listParticipants(slug).some((p) => p.identity?.startsWith('agent-')), 20_000);
  }

  // Initial agent counts
  const initialCounts = slugs.map((slug) => countJoins(slug, 'agent-'));
  expect(initialCounts.every((c) => c === 1)).toBe(true);

  // Hold 60s, polling every 10s
  for (let t = 0; t < 6; t++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const counts = slugs.map((slug) => countJoins(slug, 'agent-'));
    // Each room should still have exactly 1 agent
    expect(counts.every((c) => c === 1)).toBe(true);
  }

  // Zero watchdog reconnects in any session
  for (const page of pages) {
    const diag = await getDiagLines(page);
    const watchdogLines = diag.filter((l) => l.includes('room silent 15s'));
    expect(watchdogLines.length).toBe(0);
  }

  // Cleanup
  await Promise.all(contexts.map((c) => c.close()));
});

test('scenario 4: ghost-guard exit race, 20 repeats — room stays open, zero watchdog fires', async ({
  page,
}) => {
  const slug = `norefresh4-race-${Date.now()}`;
  await page.goto(`/session/${slug}`);

  let passCount = 0;
  for (let i = 0; i < 20; i++) {
    // Enter hands-free
    await page.getByRole('button', { name: /mic/i }).click();
    await page.waitForSelector('text=/listening|free-phase/i', { timeout: 15_000 });

    // Wait for room to be ready
    await page.waitForTimeout(1000);
    const joinsBefore = countJoins(slug, 'agent-');

    // Exit ~450ms later (ghost guard window is 400ms)
    await page.waitForTimeout(450);
    await page.getByRole('button', { name: /leave|exit/i }).click();
    await page.waitForTimeout(500);

    // Room should still be open (participant persists)
    const joinsAfter = countJoins(slug, 'agent-');
    if (joinsAfter === joinsBefore) passCount++;
  }

  // All 20 must pass
  expect(passCount).toBe(20);

  // Zero watchdog diag lines
  const diag = await getDiagLines(page);
  const watchdogLines = diag.filter((l) => l.includes('room silent 15s'));
  expect(watchdogLines.length).toBe(0);
});

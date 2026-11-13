import { type Page, expect, test } from '@playwright/test';
import { diag } from './mainframe-c-lib';

/** HF-FIX e2e (hf-strip-wordless-and-bargein-fix, 11-04; keyword law 11-13)
 *  — regression spec for the owner's stage bugs. One session per test (the
 *  stage brain is single-worker — runs serialize, never interleave).
 *
 *  KEYWORDS, NOT BARGE-IN (owner 11-13 r2): sound in the mic never touches a
 *  playing reply — it keeps talking until a keyword is decoded; the voice
 *  agent's 'voice_command' (stop / pause / resume / faster / slower) does what
 *  the deck's buttons do.
 *  R2 — sustained mic levels over a playing reply do NOT pause it (no barge
 *       line, the deck keeps playing).
 *  R1 — played-out reply is not echo evidence: after the reply FULLY plays,
 *       a user turn repeating its words must land (no 'echo discard').
 *  R3 — mic sound over the reply is never a turn: the cycle never enters
 *       processing, no user message lands.
 *  CMD — the commands through the voice-test seam window.__ozVoiceCommand
 *       (the agent's RPC; sim rooms have none): pause → paused, resume →
 *       playing, faster → 1.5x while still playing, stop → idle.
 *  BUG-1 — the free strip is wordless: dots only; words ride aria-labels.
 */

const S22 = { width: 360, height: 780 };
test.use({ viewport: S22, hasTouch: true });

const REPLY = 'the reply the phone is speaking out loud right now';

async function stubTts(page: Page) {
  const pcm = Buffer.alloc(24000 * 6 * 2);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(Math.round(800 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
  await page.route('**/api/tts/stream', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: pcm });
  });
}

async function freshSession(page: Page) {
  await stubTts(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('bifrost-voice-test', '1');
    } catch {
      /* private mode */
    }
  });
  const name = `e2e-hfbarge-${Date.now().toString(36)}`;
  const r = await page.request.post('/api/session', { data: { name } });
  expect(r.ok()).toBe(true);
  const j = (await r.json()) as { id?: string };
  await page.goto(`/session/${name}${j.id ? `?id=${j.id}` : ''}`);
  await page.getByTestId('composer-mic').tap();
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('free-strip')).not.toContainText('connecting', {
    timeout: 30_000,
  });
  return name;
}

const count = async (page: Page, line: string) =>
  (await diag(page)).filter((l: string) => l.includes(line)).length;
const levels = (page: Page, v: number) =>
  page.evaluate((x) => {
    (window as unknown as { __ozLevels?: number[] }).__ozLevels = Array(9).fill(x);
  }, v);

test('R2: sustained mic levels over a playing reply do not pause it', async ({ page }) => {
  test.setTimeout(180_000);
  await freshSession(page);
  await page.evaluate((t) => {
    (window as unknown as { __ozSpeak?: (t: string) => void }).__ozSpeak?.(t);
  }, REPLY);
  const deck = page.locator('.oz-deck');
  await expect(deck).toContainText('speaking', { timeout: 15_000 });
  await levels(page, 0.9); // the owner talks — no keyword
  await page.waitForTimeout(1500); // well past the old 400 ms barge sustain
  await expect(deck, 'the reply keeps talking').toContainText('speaking');
  await expect(page.getByRole('button', { name: 'pause speech' })).toBeVisible();
  await levels(page, 0);
  await page.waitForTimeout(1000);
  await expect(deck).toContainText('speaking');
  expect(await count(page, 'barge-in'), 'no barge line').toBe(0);
});

test('R1: a turn repeating PLAYED-OUT speech is the user, never an echo', async ({ page }) => {
  test.setTimeout(180_000);
  const slug = await freshSession(page);

  // the reply plays out COMPLETELY (quiet levels: the fake tone must not barge)
  await page.evaluate((t) => {
    (window as unknown as { __ozSpeak?: (t: string) => void }).__ozSpeak?.(t);
  }, REPLY);
  const deck = page.locator('.oz-deck');
  await expect(deck).toContainText('speaking', { timeout: 15_000 });
  await page.evaluate(() => {
    (window as unknown as { __ozLevels?: number[] }).__ozLevels = Array(9).fill(0);
  });
  await expect(deck, 'playback must finish naturally').toHaveCount(0, { timeout: 30_000 });

  // the "user" says exactly what was said — stale words are not evidence
  await page.request.post(`/api/session/${slug}/messages`, {
    data: { text: REPLY, async: true },
  });
  await page.waitForTimeout(5_000);
  const d = (await diag(page)).join('\n');
  expect(d, 'played-out speech is the user, not an echo (red on ee0d0c61)').not.toContain(
    'echo discard: prompt matches the spoken reply'
  );
});

test('R3+BUG-1: strip wordless; mic sound over the reply is never a turn', async ({ page }) => {
  test.setTimeout(180_000);
  const slug = await freshSession(page);
  const strip = page.getByTestId('free-strip');
  const freePhase = page.getByTestId('free-phase');

  // BUG-1: the listening strip is dots-only — no words, ever
  await expect(strip).not.toContainText('hands-free');
  await expect(strip).not.toContainText('working');

  await page.evaluate((t) => {
    (window as unknown as { __ozSpeak?: (t: string) => void }).__ozSpeak?.(t);
  }, REPLY);
  const deck = page.locator('.oz-deck');
  await expect(deck).toContainText('speaking', { timeout: 15_000 });
  await levels(page, 0.9);
  await page.waitForTimeout(1500);
  await levels(page, 0);
  await page.waitForTimeout(3_000);
  // no turn: the cycle never left listening, nothing was sent
  await expect(freePhase).toHaveAttribute('data-cycle', 'listening');
  const msgs = (await (await page.request.get(`/api/session/${slug}/messages`)).json()) as {
    role: string;
  }[];
  expect(msgs.filter((m) => m.role === 'user'), 'no user message lands').toEqual([]);
  expect(await count(page, 'barge-in')).toBe(0);
});

test('CMD: pause / resume / faster / stop do what the deck buttons do', async ({ page }) => {
  test.setTimeout(180_000);
  await freshSession(page);
  const cmd = (c: string) =>
    page.evaluate(
      (x) =>
        (window as unknown as { __ozVoiceCommand?: (c: string) => boolean }).__ozVoiceCommand?.(x),
      c
    );
  await page.evaluate((t) => {
    (window as unknown as { __ozSpeak?: (t: string) => void }).__ozSpeak?.(t);
  }, REPLY);
  const deck = page.locator('.oz-deck');
  const rate = deck.locator('.oz-rate button[aria-pressed="true"]');
  await expect(deck).toContainText('speaking', { timeout: 15_000 });
  await expect(rate).toHaveText('1x');
  expect(await cmd('pause')).toBe(true);
  await expect(deck).toContainText('paused');
  expect(await cmd('resume')).toBe(true);
  await expect(deck).toContainText('speaking');
  expect(await cmd('faster')).toBe(true);
  await expect(rate).toHaveText('1.5x');
  await expect(deck, 'faster only changes the rate — still playing').toContainText('speaking');
  expect(await page.evaluate(() => localStorage.getItem('oz-tts-rate'))).toBe('1.5');
  expect(await cmd('stop')).toBe(true);
  await expect(deck).toHaveCount(0, { timeout: 5_000 });
  expect(await cmd('hello')).toBe(false); // not a command
});

import { type Page, expect, test } from '@playwright/test';
import { diag } from './mainframe-c-lib';
import {
  synthAll,
  micArgs,
  flushLines,
  freshRoom,
  sendUserTurn,
  userMsgCount,
  waitForAssistant,
  W_USER,
} from './seam-lib';

const S22 = { width: 360, height: 780 };
test.use({ viewport: S22, hasTouch: true, launchOptions: { args: micArgs(W_USER, true) } });
synthAll();

test('T0 baseline: a real PTT hold rides the machinery (flush log)', async ({ page }) => {
  test.setTimeout(240_000);
  // text mode: the PTT hold lives on the composer pill (hands-free has no
  // hold — keyword turn-taking). The room warms + the agent dispatches on
  // the press; the looper WAV is the captured voice.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('bifrost-voice-test', '1');
    } catch {
      /* private mode */
    }
  });
  const name = `e2e-seam-${Date.now().toString(36)}`;
  const r = await page.request.post('/api/session', { data: { name } });
  expect(r.ok()).toBe(true);
  const j = (await r.json()) as { id?: string };
  const sessionId = j.id || name;
  await page.goto(`/session/${name}${j.id ? `?id=${j.id}` : ''}`);
  const mic = page.getByTestId('composer-mic');
  await expect(mic).toBeVisible({ timeout: 15_000 });
  const before = flushLines(6);
  await mic.dispatchEvent('pointerdown', { pointerId: 1, button: 0, isPrimary: true });
  await page.waitForTimeout(2_500); // arm (250ms) + capture a phrase or two
  await mic.dispatchEvent('pointerup', { pointerId: 1, isPrimary: true });
  // THE PROOF: the hold's commit rode the PTT machinery
  await expect.poll(async () => flushLines(6), { timeout: 30_000 }).toBeGreaterThan(before);
  // the turn LANDED (WAV speech -> real STT -> flush -> the brain answered —
  // the observable effect paired with the log-line proof)
  await waitForAssistant(page, sessionId, 120_000);
});

test('T1 unify: a pure VOICE barge rides THE SAME machinery', async ({ page }) => {
  test.setTimeout(300_000);
  const slug = await freshRoom(page);
  const before = flushLines(6);
  // a reply arrives at the deck (real brain, real Mac TTS)
  await sendUserTurn(page, slug, 'Say exactly: seam one');
  const deck = page.locator('.oz-deck');
  await expect(deck).toBeVisible({ timeout: 150_000 });
  await expect(deck).toContainText('speaking', { timeout: 60_000 });
  // the looping WAV barges on REAL levels — the deck must pause (same state
  // the finger-pause produces), then quiet debounce commits ONCE
  await expect(deck).toContainText('paused', { timeout: 30_000 });
  await expect.poll(async () => flushLines(6), { timeout: 40_000 }).toBeGreaterThan(before);
  // the commit is a turn: the merged prompt lands as a user message
  await expect
    .poll(async () => userMsgCount(page, slug), { timeout: 40_000 })
    .toBeGreaterThanOrEqual(2);
});

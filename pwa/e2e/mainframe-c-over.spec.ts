import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  center,
  diag,
  ensureVoiceTest,
  homeVt,
  phase,
  quietRoom,
  shot,
  users,
  vtMsgs,
} from './mainframe-c-lib';

/** MAINFRAME-C · hands-free after the hold, MAIN's mode rules: let go before
 *  the mic is even live — nothing was captured, hands-free stays on; then the
 *  user keeps talking: "what is three plus three? over." → the agent's
 *  keyword commit (free_state processing) → the reply spoken on the front
 *  page → the mic back → the ■ key ends it. Voice tests on (voice-test). */

const WAV = join(__dirname, 'fixtures/roots-over-en.wav'); // 0.6 s · "What is three plus three? Over." · 4 s

// the user has allowed the mic: without a grant, headless Chromium answers the
// Permissions API 'prompt' or 'denied' (by version/flags) and the hold stops at that gate
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(process.env.PW_JITLESS ? ['--js-flags=--jitless'] : []),
    ],
  },
});

test.beforeAll(async ({ request }) => ensureVoiceTest(request));
// every voice test starts in a quiet room (see quietRoom)
test.beforeEach(async () => {
  console.log(`quiet room after ${await quietRoom('voice-test')}ms`);
});

test('let go before the mic is live → hands-free stays; “over” sends; spoken here; ■ ends it', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const before = users(await vtMsgs(request)).length;
  await homeVt(page);
  const roots = phase(page);
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await expect(roots).toHaveAttribute('data-armed', 'hold', { timeout: 2_000 });
  await page.mouse.up(); // the cold room is still opening: nothing captured
  expect(['opening', 'off']).toContain(await roots.getAttribute('data-phase'));
  await expect(page.getByTestId('roots-say')).toContainText('nothing captured yet');
  // the mic comes up anyway — hands-free, MAIN's mode rule
  await expect(roots).toHaveAttribute('data-phase', 'listening', { timeout: 25_000 });
  expect(await page.evaluate(() => localStorage.getItem('oz-mode'))).toBe('free');
  await shot(page, '14-hands-free-after-release');

  // the user keeps talking: "… over" → the agent commits, the mic pauses
  await expect(roots).toHaveAttribute('data-phase', 'working', { timeout: 40_000 });
  await expect
    .poll(async () => users(await vtMsgs(request)).length, { timeout: 30_000 })
    .toBeGreaterThan(before);
  const said = users(await vtMsgs(request)).pop()!;
  console.log(`over: landed: ${said.text}`);
  expect(said.text).toMatch(/three plus three/i);
  expect(said.text).not.toMatch(/\bover\b\W*$/i); // the keyword is protocol, never content

  // spoken here, then the mic is back
  await expect(roots).toHaveAttribute('data-phase', 'speaking', { timeout: 120_000 });
  console.log(`over: speaking: ${await page.getByTestId('roots-say').textContent()}`);
  await expect(roots).toHaveAttribute('data-phase', 'listening', { timeout: 90_000 });
  expect(new URL(page.url()).pathname).toBe('/');

  // ■ ends hands-free: the device goes dark, the keyboard mode stands
  await page.getByTestId('roots-stop').click();
  await expect(roots).toHaveAttribute('data-phase', 'off');
  await expect(roots).not.toHaveAttribute('data-free', '');
  await expect(page.getByTestId('roots-stop')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('oz-mode'))).toBe('text');
  const d = await diag(page);
  console.log(d.filter((l) => l.startsWith('roots ')).join('\n'));
  expect(d.some((l) => /roots “over” — the turn is sent/.test(l))).toBe(true);
  expect(d.some((l) => /hands-free off \(stop\)/.test(l))).toBe(true);
});

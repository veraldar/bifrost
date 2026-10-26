import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  center,
  consoleTap,
  diag,
  ensureVoiceTest,
  homeVt,
  mainTotal,
  phase,
  quietRoom,
  shot,
  tokenRooms,
  users,
  vtMsgs,
} from './mainframe-c-lib';

/** MAINFRAME-C · hold the roots, for real: Chrome's capture path plays
 *  "what is two plus two?" as the mic → LiveKit → lk-agent-ygg → STT → the
 *  brain → the reply spoken on the front page. Voice tests on: the voice-test
 *  room, never MAIN. The page never leaves `/` until the test taps. */

const WAV = join(__dirname, 'fixtures/first-turn-en.wav');

test.use({
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

test('hold → talk → let go = sent → the reply is spoken here → hands-free stays → tap carries it into MAIN', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const rooms = tokenRooms(page);
  const con = consoleTap(page);
  const mainBefore = await mainTotal(request);
  const vtBefore = users(await vtMsgs(request)).length;
  await homeVt(page);
  const roots = phase(page);

  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  const t0 = Date.now();
  await page.mouse.down();
  expect(await roots.evaluate((el) => el.classList.contains('heard'))).toBe(true); // amber, this frame
  // a cold room: token, signal, the agent's dispatch — the roots say so
  await expect(roots).toHaveAttribute('data-phase', /opening|talk/, { timeout: 5_000 });
  await expect(roots).toHaveAttribute('data-phase', 'talk', { timeout: 25_000 });
  const liveMs = Date.now() - t0;
  await expect(page.getByTestId('roots-say')).toContainText('heard · talk · let go to send');
  await shot(page, '8-talk');
  // hands-free started on the spot: MAIN's own mode key says so
  expect(await page.evaluate(() => localStorage.getItem('oz-mode'))).toBe('free');
  await page.waitForTimeout(2_800); // the utterance (0.4–2 s into the wav) + a short tail
  await page.mouse.up();
  const releasedAt = Date.now();

  // sent: the mic pauses, the roots walk — and the page is still the list
  await expect(roots).toHaveAttribute('data-phase', 'working', { timeout: 3_000 });
  await expect(page.getByTestId('roots-say')).toContainText('sent · awaiting answer');
  expect(new URL(page.url()).pathname).toBe('/');
  await shot(page, '9-working');

  // the words land in the voice-test room
  await expect
    .poll(async () => users(await vtMsgs(request)).length, { timeout: 30_000 })
    .toBeGreaterThan(vtBefore);
  const said = users(await vtMsgs(request)).pop()!;
  console.log(`roots: transcript ${Date.now() - releasedAt}ms after release: ${said.text}`);
  expect(said.text).toMatch(/two plus two/i);

  // the reply is spoken HERE: the roots breathe green, its words on them
  await expect(roots).toHaveAttribute('data-phase', 'speaking', { timeout: 120_000 });
  const spokeMs = Date.now() - releasedAt;
  await expect(roots).toHaveAttribute('data-s', 'speaking');
  await expect(page.getByTestId('roots-say')).toHaveText(/\S/);
  console.log(
    `roots: reply speaking ${spokeMs}ms after release: ${await page.getByTestId('roots-say').textContent()}`
  );
  await shot(page, '10-speaking');
  expect(new URL(page.url()).pathname).toBe('/');

  // the reply ends → the mic comes back: hands-free, still on the list
  await expect(roots).toHaveAttribute('data-phase', 'listening', { timeout: 90_000 });
  console.log(con.filter((l) => /tts|audio|play/i.test(l)).join('\n'));
  await expect(roots).toHaveAttribute('data-free', '');
  await expect(page.getByTestId('roots-say')).toContainText('listening');
  await expect(page.getByTestId('roots-stop')).toBeVisible();
  await shot(page, '11-listening');
  // heard here = never re-played when MAIN opens; read = no unread dot
  const marks = await page.evaluate(() => ({
    heard: JSON.parse(localStorage.getItem('oz-heard') || '{}')['voice-test'] || 0,
    read: JSON.parse(localStorage.getItem('oz-read') || '{}')['voice-test'] || 0,
  }));
  const reply = (await vtMsgs(request)).filter((m) => m.role === 'assistant').pop()!;
  expect(marks.heard).toBe(reply.time);
  expect(marks.read).toBeGreaterThanOrEqual(reply.time);

  // MAIN: never a room, not one message more
  console.log(`token rooms: ${rooms.join(', ')} · mic+agent live ${liveMs}ms after press`);
  expect(rooms.length).toBeGreaterThan(0);
  expect(rooms.every((r) => r === 'voice-test')).toBe(true);
  expect(await mainTotal(request)).toBe(mainBefore);
  const d = await diag(page);
  console.log(d.filter((l) => l.startsWith('roots ')).join('\n'));

  // carry-over: a tap now opens MAIN (its voice-test twin) — hands-free on
  // there too, MAIN's own restore path; the reply is not played again
  await page.mouse.click(c.x, c.y, { delay: 40 });
  await expect(page).toHaveURL(/\/session\/voice-test/);
  await expect(page.getByTestId('free-strip')).toBeVisible({ timeout: 20_000 });
  await shot(page, '12-carried-into-main');
  await page.waitForTimeout(2_000);
  const replays = (await diag(page)).filter((l) => /on-open unheard reply — auto-play/.test(l));
  expect(replays).toEqual([]);
  // leave hands-free there (MAIN's own exit) — the device goes back to text
  await page.getByTestId('free-exit').click();
  await expect(page.getByTestId('free-strip')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('oz-mode'))).toBe('text');
});

test('slide off while talking = drop: red, nothing sent, the hold is undone', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await homeVt(page);
  const roots = phase(page);
  const c = await center(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await expect(roots).toHaveAttribute('data-phase', 'talk', { timeout: 25_000 });
  await page.waitForTimeout(2_500); // words are in the agent's buffer now
  const before = users(await vtMsgs(request)).length;
  await page.mouse.move(c.x, c.y - 240, { steps: 6 }); // up, off the roots
  await expect(roots).toHaveAttribute('data-s', 'drop');
  await expect(page.getByTestId('roots-say')).toContainText('drop');
  await shot(page, '13-drop');
  await page.mouse.move(c.x, c.y, { steps: 3 }); // back in: the talk continues
  await expect(roots).toHaveAttribute('data-s', 'heard');
  await page.mouse.move(c.x, c.y - 240, { steps: 3 });
  await expect(roots).toHaveAttribute('data-s', 'drop');
  await page.mouse.up();
  await expect(roots).toHaveAttribute('data-phase', 'off');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('oz-mode'))).toBe('text');
  await page.waitForTimeout(8_000); // a commit would have landed by now
  expect(users(await vtMsgs(request)).length).toBe(before);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('keyboard parity: Space held = talk, Esc = drop; Space held + let go = sent; the stop key by keyboard', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await homeVt(page);
  const roots = phase(page);
  const hit = page.getByTestId('roots-hit');
  await hit.focus();

  // Space held → talk; Esc → drop (the keyboard's slide-off)
  await page.keyboard.down(' ');
  expect(await roots.evaluate((el) => el.classList.contains('heard'))).toBe(true);
  await expect(roots).toHaveAttribute('data-phase', 'talk', { timeout: 25_000 });
  const before = users(await vtMsgs(request)).length;
  await page.keyboard.press('Escape');
  await page.keyboard.up(' ');
  await expect(roots).toHaveAttribute('data-phase', 'off');
  await page.waitForTimeout(6_000);
  expect(users(await vtMsgs(request)).length).toBe(before);

  // Space held through the utterance, let go → sent (the room is warm now)
  await hit.focus();
  await page.keyboard.down(' ');
  await expect(roots).toHaveAttribute('data-phase', 'talk', { timeout: 15_000 });
  await page.waitForTimeout(3_500);
  await page.keyboard.up(' ');
  await expect(roots).toHaveAttribute('data-phase', 'working', { timeout: 3_000 });
  await expect
    .poll(async () => users(await vtMsgs(request)).length, { timeout: 30_000 })
    .toBeGreaterThan(before);
  expect(users(await vtMsgs(request)).pop()!.text).toMatch(/two plus two/i);
  expect(new URL(page.url()).pathname).toBe('/');

  // the stop key, reached by Tab, pressed with Enter: hands-free ends
  const stop = page.getByTestId('roots-stop');
  await expect(stop).toBeVisible();
  let reached = false;
  for (let i = 0; i < 5 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await stop.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  await page.keyboard.press('Enter');
  await expect(roots).not.toHaveAttribute('data-free', '');
  expect(await page.evaluate(() => localStorage.getItem('oz-mode'))).toBe('text');
  // a run already going finishes quietly; the roots settle back to the row
  await expect(roots).toHaveAttribute('data-phase', 'off', { timeout: 120_000 });
});

import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** UX-BATCH #5 — voice tests get their own room. Settings → voice tests on →
 *  MAIN opens `voice-test` (room = slug) → a real PTT turn (Chrome capture
 *  plays "what is two plus two?" → LiveKit → lk-agent-ygg → Qwen3-ASR) lands
 *  in the voice-test session; MAIN is never joined as a room and its
 *  transcript does not move. The header chip turns it off → MAIN again. */

const WAV = join(__dirname, 'fixtures/first-turn-en.wav');

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      ...(process.env.PW_JITLESS ? ['--js-flags=--jitless'] : []),
    ],
  },
});

test('#5 · voice-test on → turns land in voice-test, MAIN untouched; off → MAIN', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const mainTotal = async () =>
    Number((await request.get('/api/session/main/messages?limit=1')).headers()['x-total-count']);
  const existed = (await request.get('/api/session/voice-test/messages?limit=1')).ok();
  const mainBefore = await mainTotal();

  const rooms: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/token') && r.method() === 'POST') {
      try {
        rooms.push(String(JSON.parse(r.postData() || '{}').room));
      } catch {
        /* not ours */
      }
    }
  });

  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('bifrost-door', 'v2');
    localStorage.setItem('bifrost-first-turn', '1');
    localStorage.setItem('oz-mode', 'text');
    localStorage.removeItem('bifrost-voice-test');
  });

  // settings: the switch
  await page.goto('/settings');
  const sw = page.getByTestId('voice-test-toggle');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('voice-test-state')).toContainText('MAIN opens voice-test');
  await page.screenshot({
    path: `${process.env.TF_SHOTS || '../artifacts'}/ux-batch-voice-test-settings.png`,
  });

  try {
    // MAIN (the tree's way back) opens the test twin
    await page.goto('/session/main');
    await expect(page).toHaveURL(/\/session\/voice-test/);
    await expect(page.getByTestId('voice-test-chip')).toBeVisible();

    // a real voice turn
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (JSON.parse(localStorage.getItem('oz-diag') || '[]') as { msg: string }[]).some((e) =>
              /\bready\b/.test(e.msg)
            )
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    const userBefore = (
      (await (await request.get('/api/session/voice-test/messages?limit=200')).json()) as {
        role: string;
      }[]
    ).filter((m) => m.role === 'user').length;
    const mic = page.getByTestId('composer-mic');
    const b = (await mic.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await expect(page.getByText(/heard · release to send/)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_500);
    await page.mouse.up();

    // the turn lands in voice-test — counted, not seen: voice-test keeps every earlier
    // "two plus two", so a visible one can be old and a one-shot count can run ahead of the turn
    const userTurns = async () =>
      (
        (await (await request.get('/api/session/voice-test/messages?limit=200')).json()) as {
          role: string;
          text: string;
        }[]
      ).filter((m) => m.role === 'user');
    await expect
      .poll(async () => (await userTurns()).length, { timeout: 30_000 })
      .toBeGreaterThan(userBefore);
    const vt = await userTurns();
    expect(vt[vt.length - 1].text).toMatch(/two plus two/i);

    // MAIN: never a room, not one message more
    console.log(`token rooms: ${rooms.join(', ')}`);
    expect(rooms.length).toBeGreaterThan(0);
    expect(rooms.every((r) => r === 'voice-test')).toBe(true);
    await page.waitForTimeout(3_000);
    expect(await mainTotal()).toBe(mainBefore);
    await page.screenshot({
      path: `${process.env.TF_SHOTS || '../artifacts'}/ux-batch-voice-test-room.png`,
    });

    // the chip turns it off → MAIN again
    await page.getByTestId('voice-test-chip').click();
    await expect(page).toHaveURL(/\/session\/main/);
    expect(await page.evaluate(() => localStorage.getItem('bifrost-voice-test'))).toBeNull();
    await expect(page.getByTestId('voice-test-chip')).toHaveCount(0);
  } finally {
    await page.evaluate(() => localStorage.removeItem('bifrost-voice-test')).catch(() => {});
    // a test that made the room cleans it up; the user's own stays
    if (!existed) {
      const r = await request.get('/api/session');
      const list = (await r.json()) as { id: string; title?: string }[];
      for (const s of list.filter((x) => x.title === 'voice-test'))
        await request.delete(`/api/session/${s.id}`);
    }
  }
});

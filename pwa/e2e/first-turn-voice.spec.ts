import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** THE FIRST VOICE TURN, for real, on the sandbox stack: Chrome's own capture
 *  path plays a spoken wav as the microphone (--use-file-for-fake-audio-capture
 *  — getUserMedia, WebRTC, LiveKit, all real; NOT the lab-mic JS injection)
 *  → lk-agent-ygg → STT (STT_MODEL on the Mac) → the transcript lands as your
 *  message → yggdrasil replies → the reply is spoken → "you are in".
 *  A throwaway session (?first=1 shows the card there) keeps MAIN clean. */

const WAV = join(__dirname, 'fixtures/first-turn-en.wav'); // "what is two plus two?" + silence

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

test('first turn: hold → speak → transcript (STT alive) → spoken reply → you are in', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const title = `e2e-first-turn-${Date.now().toString(36)}`;
  const made = await request.post('/api/session', { data: { name: title } });
  expect(made.ok()).toBe(true);
  const sess = (await made.json()) as { id: string };
  const slug = title; // already slug-shaped

  try {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('bifrost-door', 'v2');
      localStorage.removeItem('bifrost-first-turn');
      localStorage.setItem('bifrost-onboard', JSON.stringify({ lang: 'en', style: 'short' }));
    });
    await page.goto(`/session/${slug}?id=${sess.id}&first=1`);
    const card = page.getByTestId('first-turn');
    await expect(card).toBeVisible();
    if ((await card.getAttribute('data-state')) === 'mic') {
      await page.getByTestId('first-allow-mic').click();
    }
    await expect(card).toHaveAttribute('data-state', 'practice');

    // hold the mic through the utterance (0.4–2 s into the wav), let go
    const mic = page.getByTestId('composer-mic');
    const b = (await mic.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await expect(page.getByText(/heard · release to send/)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(3_500);
    const releasedAt = Date.now();
    await page.mouse.up();
    await expect(card).toHaveAttribute('data-state', /sent|heard|in/);

    // STT alive: the words come back as YOUR message
    await expect(card).toHaveAttribute('data-state', /heard|in/, { timeout: 25_000 });
    const heardMs = Date.now() - releasedAt;
    const heard = (await page.getByTestId('first-heard').textContent().catch(() => '')) || '';
    console.log(`first turn: transcript ${heardMs}ms after release: ${heard}`);
    await expect(page.getByText(/two plus two/i).first()).toBeVisible();

    // the reply lands and is spoken, then "you are in"
    await expect(card).toHaveAttribute('data-state', 'in', { timeout: 90_000 });
    console.log(`first turn: reply ${Date.now() - releasedAt}ms after release`);
    await expect(page.getByTestId('first-in')).toHaveText('you are in. talk to your tree.');
    await expect(page.getByText(/\b(4|four)\b/i).first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('bifrost-first-turn'))).toBeTruthy();
    const lines = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem('oz-diag') || '[]') as { kind: string; msg: string }[]).map(
        (e) => `${e.kind} ${e.msg}`
      )
    );
    const stt = lines.find((l) => /first-turn: transcript/.test(l));
    console.log(`diag: ${stt}`);
    expect(lines.some((l) => /user-agi\.wav/.test(l))).toBe(false); // never the lab mic
    await page.screenshot({ path: `${process.env.TF_SHOTS || '../artifacts'}/door-8-you-are-in.png` });

    // dismissed → the plain session, the card never comes back on this device
    await page.getByTestId('first-ok').click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('first-turn')).toHaveCount(0);
  } finally {
    await request.delete(`/api/session/${sess.id}`);
  }
});

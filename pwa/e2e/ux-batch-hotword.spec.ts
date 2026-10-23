import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/** UX-BATCH #3 — "Bifrost" loses its attack at utterance start.
 *  The engine as served takes no bias term (Mac /v1/audio/transcriptions:
 *  file + model only), and none is needed: with its onset intact Qwen3-ASR
 *  writes "Bifrost" every time; cut 80-220 ms of onset and it writes
 *  "Defrost / The Frost / Frost" (docs/reviews/ux-batch-report.md table).
 *  The onset was lost on OUR side: the hold UI said "heard" before the mic
 *  was capturing. Now "heard" (+ a haptic tick) comes only when it is live.
 *  Real stack: Chrome's capture plays fixtures/bifrost-en.wav (1.2 s beat,
 *  "Bifrost bridge voice test.") → LiveKit → lk-agent-ygg → Qwen3-ASR. */

const WAV = join(__dirname, 'fixtures/bifrost-en.wav');

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

test('#3 · hold: "opening the mic…" until capture is live, then "heard" — and "Bifrost" arrives whole', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const name = `e2e-ux-hotword-${Date.now().toString(36)}`;
  const made = await request.post('/api/session', { data: { name } });
  expect(made.ok()).toBe(true);
  const { id } = (await made.json()) as { id: string };
  try {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('bifrost-door', 'v2');
      localStorage.setItem('bifrost-first-turn', '1');
      localStorage.setItem('oz-mode', 'text');
    });
    await page.goto(`/session/${name}?id=${id}`);
    // the voice room warms on page load (mic off) — wait for it
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
    // every cue the status line shows, in order, with its time
    await page.evaluate(() => {
      const w = window as unknown as { __cues: { t: number; s: string }[] };
      w.__cues = [];
      const el = document.querySelector('p.oz-phase');
      const rec = () => {
        const s = el?.textContent || '';
        if (w.__cues[w.__cues.length - 1]?.s !== s) w.__cues.push({ t: performance.now(), s });
      };
      new MutationObserver(rec).observe(el!, { subtree: true, childList: true, characterData: true });
    });

    const mic = page.getByTestId('composer-mic');
    const b = (await mic.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await expect(page.getByText(/heard · release to send/)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(4_200); // the wav: 1.2 s beat + the sentence + tail
    await page.mouse.up();

    const cues = await page.evaluate(
      () => (window as unknown as { __cues: { t: number; s: string }[] }).__cues
    );
    const opening = cues.findIndex((c) => /opening the mic/.test(c.s));
    const heard = cues.findIndex((c) => /heard · release to send/.test(c.s));
    console.log(`cues: ${cues.map((c) => c.s.replace(/^\W+/, '')).join(' → ')}`);
    expect(opening).toBeGreaterThanOrEqual(0); // the cue never claims "heard" early
    expect(heard).toBeGreaterThan(opening);
    console.log(`"opening the mic…" shown ${Math.round(cues[heard].t - cues[opening].t)}ms before "heard"`);
    const diag = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem('oz-diag') || '[]') as { kind: string; msg: string }[]).map(
        (e) => `${e.kind} ${e.msg}`
      )
    );
    const live = diag.find((l) => /ptt mic live \d+ms after press/.test(l));
    console.log(`diag: ${live}`);
    expect(live).toBeTruthy();

    // the real pipeline: the first word keeps its attack
    const you = page.locator('[data-mi]', { hasText: /frost/i });
    await expect(you.first()).toBeVisible({ timeout: 30_000 });
    const said = (await you.first().textContent()) || '';
    console.log(`transcript: ${said}`);
    // (textContent runs the time stamp into the words: "…04:55 AMBifrost Bridge…")
    expect(said).toMatch(/Bifrost Bridge/i);
  } finally {
    await request.delete(`/api/session/${id}`);
  }
});

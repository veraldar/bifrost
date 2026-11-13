import { type Page, expect, test } from '@playwright/test';

/** KEYWORDS, NOT BARGE-IN (owner 11-13 r2): "when you speak and I speak it
 *  pauses you — continue talking until my keyword is decoded and applied".
 *  Sound in the mic never touches a playing reply; the agent's 'voice_command'
 *  (stop / pause / resume / faster / slower) does what the deck's buttons do.
 *  The stall regime below (a reply whose stream lags at a piece boundary) is
 *  kept for the two laws that still matter there: talking over the stall never
 *  pauses it — the late tail plays when it lands, A is never hung up — and a
 *  'stop' ends it cleanly. The old barge pause / resume-timer / commit cases
 *  (R4c-R4e) are gone with that machinery. A command comes through the
 *  voice-test seam window.__ozVoiceCommand (no voice agent in sim rooms).
 *
 *  THE REGIME (test-only seam, no product change): an init-script patches
 *  window.fetch (under the bifrost-voice-test flag, like __ozSpeak/__ozLevels)
 *  and answers POST /api/tts/stream with a Response over a ReadableStream we
 *  control. (A route.continue({url}) proxy cannot do this: playwright buffers
 *  the body until the response closes.) Reply A streams 3 x 10s of PCM ~1.5s
 *  apart, then the stream is HELD OPEN until window.__ozTtsStream.release()
 *  enqueues the tail and closes it. The deck plays ~30s of audio (rate 4 ≈
 *  7.5s), exhausts its buffer and sits in 'loading' with userPaused=false —
 *  the state production reaches when the stream lags (onPieceEnded 'boundary
 *  stall'). Reply B (every later fetch) is one normal 3s chunk.
 *
 *  Observed through the DOM + two init-script taps only (no __ozDeck seam):
 *  deck phase = .oz-deck markup sampled every 50ms in-page; audio activity =
 *  HTMLMediaElement.play() calls and the Audio elements, sampled in-page. */

test.use({ viewport: { width: 360, height: 780 }, hasTouch: true });

const A_TEXT =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango';

type AudioSample = { p: boolean; c: number; s: string; d: number };
type Fetch = { text: string; t: number };
type Ev = { t: number; kind: string; msg: string };
type Seam = {
  __ozTtsStream: { release(): void; reset(): void; abortedAt: number };
  __ozTtsFetches: Fetch[];
};
type Tts = {
  /** the lagging stream's tail finally arrives (and the stream ends) */
  release: () => Promise<void>;
  /** ms epoch the CLIENT aborted A's stream (0 = never) */
  abortedAt: () => Promise<number>;
};

async function setup(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('bifrost-voice-test', '1');
      localStorage.setItem('oz-tts-rate', '4');
    } catch {
      /* private mode */
    }
    const w = window as unknown as Seam & {
      __plays: number[];
      __ph: [number, string][];
      __aud: HTMLAudioElement[];
      __au: [number, AudioSample[]][];
      __pev: number[];
    };
    w.__plays = [];
    w.__ph = [];
    // AUDIO taps (the phase label is coerced to 'paused' by the store while a
    // barge window is open, so it cannot prove silence): every Audio() the deck
    // makes is tracked and sampled — paused / currentTime / src / duration —
    // and every media 'play' event is recorded.
    w.__aud = [];
    w.__au = [];
    w.__pev = [];
    const RealAudio = window.Audio;
    const AudioTap = function (...a: ConstructorParameters<typeof Audio>) {
      const e = new RealAudio(...a);
      w.__aud.push(e);
      return e;
    } as unknown as typeof Audio;
    AudioTap.prototype = RealAudio.prototype;
    window.Audio = AudioTap;
    document.addEventListener('play', () => w.__pev.push(Date.now()), true);
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...a) {
      w.__plays.push(Date.now());
      return play.apply(this, a as []);
    };

    // TEST-ONLY SEAM: held-open TTS stream (see header). Reply A = 3 x 10s
    // chunks 1.5s apart, then HOLD until release(); later replies = one 3s chunk.
    const pcmBytes = (sec: number, hz: number) => {
      const n = 24000 * sec;
      const i16 = new Int16Array(n);
      for (let i = 0; i < n; i++)
        i16[i] = Math.round(800 * Math.sin((2 * Math.PI * hz * i) / 24000));
      return new Uint8Array(i16.buffer);
    };
    w.__ozTtsFetches = [];
    const hold: { c: ReadableStreamDefaultController<Uint8Array> | null } = { c: null };
    const seam = {
      abortedAt: 0,
      release() {
        if (!hold.c) return;
        try {
          hold.c.enqueue(pcmBytes(3, 220));
          hold.c.close();
        } catch {
          /* already aborted */
        }
      },
      reset() {
        hold.c = null;
        seam.abortedAt = 0;
        w.__ozTtsFetches.length = 0;
      },
    };
    w.__ozTtsStream = seam;
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/tts/stream') || (init?.method || 'GET').toUpperCase() !== 'POST')
        return realFetch(input, init);
      let text = '';
      try {
        text = (JSON.parse(String(init?.body || '{}')) as { text?: string }).text || '';
      } catch {
        /* not json */
      }
      const isA = w.__ozTtsFetches.length === 0;
      w.__ozTtsFetches.push({ text, t: Date.now() });
      const headers = { 'Content-Type': 'application/octet-stream' };
      if (!isA) return Promise.resolve(new Response(pcmBytes(3, 330), { status: 200, headers }));
      const timers: ReturnType<typeof setTimeout>[] = [];
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          hold.c = c;
          [0, 1500, 3000].forEach((ms, i) =>
            timers.push(
              setTimeout(() => {
                try {
                  // 10s = exactly PIECE_SEC: appendPcm carves ALL pending audio
                  // once it reaches 10s, so each chunk yields one piece (7s
                  // chunks carved 14s into ONE piece, the 3rd stayed pending,
                  // and with the stream held open the 2-piece prebuffer was
                  // never met → deck stuck 'loading', no play())
                  c.enqueue(pcmBytes(10, 220 + i * 20));
                } catch {
                  /* aborted */
                }
              }, ms)
            )
          );
          init?.signal?.addEventListener('abort', () => {
            timers.forEach(clearTimeout);
            seam.abortedAt = Date.now();
            try {
              c.error(new DOMException('aborted', 'AbortError'));
            } catch {
              /* already closed */
            }
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers }));
    };

    setInterval(() => {
      const d = document.querySelector('.oz-deck');
      let p = 'idle';
      if (d) {
        if (d.querySelector('[aria-label="paused"]')) p = 'paused';
        else if (d.querySelector('[aria-label="speaking"]')) p = 'playing';
        else if (d.querySelector('.oz-synth')) p = 'loading';
      }
      const now = Date.now();
      w.__ph.push([now, p]);
      w.__au.push([
        now,
        w.__aud.map((e) => ({ p: e.paused, c: e.currentTime, s: e.src, d: e.duration })),
      ]);
    }, 50);
  });
  const name = `e2e-r4-${Date.now().toString(36)}`;
  const r = await page.request.post('/api/session', { data: { name } });
  expect(r.ok()).toBe(true);
  const j = (await r.json()) as { id?: string };
  await page.goto(`/session/${name}${j.id ? `?id=${j.id}` : ''}`);
  await page.getByTestId('composer-mic').tap();
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('free-strip')).not.toContainText('connecting', {
    timeout: 30_000,
  });
  const tts: Tts = {
    release: () => page.evaluate(() => (window as unknown as Seam).__ozTtsStream.release()),
    abortedAt: () => page.evaluate(() => (window as unknown as Seam).__ozTtsStream.abortedAt),
  };
  const fetches = () => page.evaluate(() => (window as unknown as Seam).__ozTtsFetches.slice());
  return { slug: name, tts, fetches };
}

const levels = (page: Page, v: number) =>
  page.evaluate((x) => {
    (window as unknown as { __ozLevels?: number[] }).__ozLevels = Array(9).fill(x);
  }, v);

const deckPhase = (page: Page) =>
  page.evaluate(() => {
    const ph = (window as unknown as { __ph: [number, string][] }).__ph;
    return ph[ph.length - 1]?.[1] ?? 'idle';
  });

async function events(page: Page): Promise<Ev[]> {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem('oz-diag') || '[]') as Ev[]
  );
}
const command = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (window as unknown as { __ozVoiceCommand?: (c: string) => boolean }).__ozVoiceCommand?.(c),
    cmd
  );

/** A speaks, then stalls at the piece boundary (stream held open). */
async function stall(page: Page) {
  await page.evaluate((t) => {
    (window as unknown as { __ozSpeak?: (t: string) => void }).__ozSpeak?.(t);
  }, A_TEXT);
  await levels(page, 0);
  await expect.poll(() => deckPhase(page), { timeout: 20_000 }).toBe('playing');
  await expect
    .poll(() => deckPhase(page), {
      timeout: 25_000,
      message: 'deck must reach the boundary stall (loading) — the lag regime',
    })
    .toBe('loading');
}

async function tailPlayedAfter(page: Page, t0: number) {
  await expect
    .poll(
      async () =>
        page.evaluate((t) => {
          const au = (window as unknown as { __au: [number, AudioSample[]][] }).__au;
          return au.some(
            ([ts, els]) => ts >= t && els.some((e) => !e.p && Math.abs(e.d - 3) < 0.2)
          );
        }, t0),
      { timeout: 8_000, message: 'the 3s tail piece must play once it lands' }
    )
    .toBe(true);
  const restarted = await page.evaluate((t) => {
    const au = (window as unknown as { __au: [number, AudioSample[]][] }).__au;
    return au.some(([ts, els]) => ts >= t && els.some((e) => !e.p && Math.abs(e.d - 10) < 0.5));
  }, t0);
  expect(restarted, 'no restart from A’s first piece').toBe(false);
}

test('R4a: talking over a stalled reply never pauses it — the late tail plays, A is never hung up', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { tts, fetches } = await setup(page);
  await stall(page);
  const tLoud = Date.now();
  await levels(page, 0.8); // the owner talks (no keyword) over the stall
  await page.waitForTimeout(1500);
  const ph = await page.evaluate(() => (window as unknown as { __ph: [number, string][] }).__ph);
  expect(
    ph.filter(([t, p]) => t >= tLoud && p === 'paused'),
    'sound in the mic never pauses the reply'
  ).toEqual([]);
  const tRelease = Date.now();
  await tts.release(); // the lagging tail lands while the owner is still talking
  await tailPlayedAfter(page, tRelease);
  const ab = await tts.abortedAt();
  expect(ab === 0 || ab > tRelease, 'A was never hung up before its tail played').toBe(true);
  expect((await fetches()).length, 'no new TTS fetch').toBe(1);
  const d = (await events(page)).map((e) => e.msg).join('\n');
  expect(d).not.toContain('barge-in');
  expect(d).not.toContain('[barge]');
});

test('R4b: "stop" over a stalled reply ends it — A is hung up, no new speech, no turn', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { slug, tts, fetches } = await setup(page);
  await stall(page);
  // the agent recognized "stop" (its RPC, here through the voice-test seam)
  expect(await command(page, 'stop')).toBe(true);
  await expect(page.locator('.oz-deck')).toHaveCount(0, { timeout: 5_000 });
  expect(await tts.abortedAt(), 'stop hung up A’s stream').toBeGreaterThan(0);
  await tts.release(); // a tail arriving after the stop plays nothing
  await page.waitForTimeout(1500);
  expect(await deckPhase(page)).toBe('idle');
  expect((await fetches()).length, 'no new TTS fetch').toBe(1);
  const msgs = (await (await page.request.get(`/api/session/${slug}/messages`)).json()) as {
    role: string;
  }[];
  expect(msgs.filter((m) => m.role === 'user'), 'a command is never a message').toEqual([]);
  await expect(page.getByTestId('free-phase')).toHaveAttribute('data-cycle', 'listening');
});

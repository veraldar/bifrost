import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/** UX-BATCH #4 — THE REPLAY TEST: "my replies come back as user turns".
 *  The worst room there is: the phone's speaker wired straight into its own
 *  mic. An init script routes every <audio> the page plays into the stream
 *  getUserMedia hands LiveKit (and to the real output), so whatever the
 *  phone says, the agent hears — LiveKit → lk-agent-ygg → Qwen3-ASR, all
 *  real. Hands-free, the reply ends in "over" (the commit keyword) and the
 *  strip is tapped after it (tap-to-send) — any echo that got in lands.
 *    A  ?echogate=0  the bug, reproduced: playback → a user turn
 *    B  the gate     playback → nothing (the mic was paused while it spoke)
 *  A is the control that proves the loop can echo at all. */

const SENTENCE = 'The bridge is open and the tree is listening, over.';

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      ...(process.env.PW_JITLESS ? ['--js-flags=--jitless'] : []),
    ],
  },
});

type M = { role: string; text: string; done?: boolean };
const msgs = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/session/${id}/messages?limit=200`)).json()) as M[];
const users = async (request: APIRequestContext, id: string) =>
  (await msgs(request, id)).filter((m) => m.role === 'user');

async function seeded(request: APIRequestContext, tag: string) {
  const name = `e2e-ux-echo-${tag}-${Date.now().toString(36)}`;
  const { id } = (await (await request.post('/api/session', { data: { name } })).json()) as {
    id: string;
  };
  await request.post(`/api/session/${id}/messages`, {
    data: { text: `Reply with exactly this sentence and nothing else: ${SENTENCE}`, async: true },
  });
  await expect
    .poll(
      async () =>
        (await msgs(request, id)).some(
          (m) => m.role === 'assistant' && m.done !== false && /bridge is open/i.test(m.text)
        ),
      { timeout: 120_000 }
    )
    .toBe(true);
  return { name, id };
}

/** the speaker → the mic, at full strength */
async function wireSpeakerToMic(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __echo: { routed: number; err: string } };
    w.__echo = { routed: 0, err: '' };
    let ctx: AudioContext | null = null;
    let mix: MediaStreamAudioDestinationNode | null = null;
    const ensure = () => {
      if (!ctx) {
        ctx = new AudioContext();
        mix = ctx.createMediaStreamDestination();
      }
      return ctx;
    };
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (!c || !c.audio) return orig(c);
      const ac = ensure();
      if (ac.state === 'suspended') await ac.resume().catch(() => {});
      return new MediaStream([mix!.stream.getAudioTracks()[0].clone()]);
    };
    const play = HTMLMediaElement.prototype.play;
    const routed = new WeakSet<HTMLMediaElement>();
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      try {
        if (!routed.has(this)) {
          const ac = ensure();
          const src = ac.createMediaElementSource(this);
          src.connect(ac.destination);
          src.connect(mix!);
          routed.add(this);
          w.__echo.routed++;
        }
      } catch (e) {
        w.__echo.err = String(e);
      }
      return play.call(this);
    };
  });
}

async function replay(page: Page, request: APIRequestContext, s: { name: string; id: string }, gate: boolean) {
  await wireSpeakerToMic(page);
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('bifrost-door', 'v2');
    localStorage.setItem('bifrost-first-turn', '1');
    localStorage.setItem('oz-mode', 'text');
  });
  await page.goto(`/session/${s.name}?id=${s.id}${gate ? '' : '&echogate=0'}`);
  const listen = page.getByRole('button', { name: 'listen' });
  await expect(listen).toBeVisible({ timeout: 30_000 });

  // hands-free: a tap on the mic; listening = the mic is hot
  await page.getByTestId('composer-mic').click();
  const free = page.getByTestId('free-phase');
  await expect(free).toContainText('tap the bars to send', { timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const before = (await users(request, s.id)).length;

  // the phone speaks its reply — into its own mic
  await listen.click();
  await expect(free).toContainText('speaking', { timeout: 30_000 });
  await expect(free).not.toContainText('speaking', { timeout: 90_000 });
  const routed = await page.evaluate(() => (window as unknown as { __echo: { routed: number } }).__echo.routed);
  expect(routed).toBeGreaterThan(0); // the reply really went through the loop
  // the agent's batch STT needs the segment's end + ~1-2 s
  await page.waitForTimeout(4_000);
  // tap-to-send: whatever the mic buffered is committed now
  await page.getByRole('button', { name: 'send what you said' }).click();
  return { before, free };
}

async function leave(page: Page) {
  const exit = page.getByRole('button', { name: 'leave hands-free' });
  if (await exit.isVisible().catch(() => false)) await exit.click().catch(() => {});
}

test('#4 A · control (?echogate=0): the speaker-to-mic loop turns the reply into a user turn', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const s = await seeded(request, 'a');
  try {
    const { before } = await replay(page, request, s, false);
    await expect
      .poll(async () => (await users(request, s.id)).length, { timeout: 30_000 })
      .toBeGreaterThan(before);
    const echo = (await users(request, s.id)).slice(before).map((m) => m.text).join(' | ');
    console.log(`A · echo landed as YOUR turn: ${echo}`);
    expect(echo).toMatch(/bridge|tree|listening|open/i);
  } finally {
    await leave(page);
    await request.delete(`/api/session/${s.id}`);
  }
});

test('#4 B · the echo gate: the phone speaks its reply, no user turn comes back', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const s = await seeded(request, 'b');
  try {
    const { before, free } = await replay(page, request, s, true);
    // 25 s of nothing: no keyword commit, no tap-to-send content
    await page.waitForTimeout(25_000);
    const after = await users(request, s.id);
    console.log(`B · user turns before ${before}, after ${after.length}`);
    expect(after.length).toBe(before);
    const diag = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem('oz-diag') || '[]') as { kind: string; msg: string }[]).map(
        (e) => `${e.kind} ${e.msg}`
      )
    );
    expect(diag.some((l) => /echo gate: mic paused while the phone speaks/.test(l))).toBe(true);
    expect(diag.some((l) => /echo gate: the phone is quiet — mic back/.test(l))).toBe(true);
  } finally {
    await leave(page);
    await request.delete(`/api/session/${s.id}`);
  }
});

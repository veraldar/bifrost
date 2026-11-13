/** REAL voice, end to end (no mock): Chrome plays a spoken wav as the microphone, the real
 *  voice agent (AGENT_NAME of the served app) transcribes it, the root answers. Needs a stack
 *  whose app dispatches its OWN agent (VOICE_ROOM_BY_ID=1 or a separate LiveKit) — e.g. the
 *  root-coord preview: PW_BASE_URL=http://127.0.0.1:8191 E2E_OC_URL=http://127.0.0.1:4191.
 *  One body, one spec file per recording (the mic file is a launch option: one per file). */
import { expect, test } from '@playwright/test';
import { realMic } from './voice-live-lib';

export function voiceCommandsSpec(kind: string, wav: string) {
  realMic(wav);
  test.setTimeout(180_000);
  type M = { info: { role: string }; parts: { type: string; text?: string }[] };
  test(`hands-free voice commands (${kind}): sound never pauses a reply; pause / continue / faster / stop do, never a message`, async ({
    page,
    request,
  }) => {
    const pv = process.env.E2E_OC_URL || 'http://127.0.0.1:4101';
    const MAIN = (
      (await (await request.get(`${pv}/session`)).json()) as { id: string; title: string }[]
    ).find((x) => x.title === '[MAIN]')!.id;
    const before = ((await (await request.get(`${pv}/session/${MAIN}/message`)).json()) as M[])
      .length;
    await page.goto(`/session/main?id=${MAIN}`);
    await page.evaluate(() => localStorage.setItem('oz-tts-rate', '1'));
    await page.reload();
    await expect(page.getByPlaceholder('message…')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('composer-mic').tap(); // hands-free
    // the wav: story … over · "hmm, that is interesting" · pause · continue · faster · stop
    const states: string[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 62_000) {
      const deck = await page
        .locator('.oz-rate')
        .isVisible()
        .catch(() => false);
      const paused =
        deck &&
        (await page
          .getByRole('button', { name: 'resume speech' })
          .isVisible()
          .catch(() => false));
      const rate = await page.evaluate(() => localStorage.getItem('oz-tts-rate'));
      const st = `${deck ? (paused ? 'paused' : 'playing') : 'off'}@${rate}`;
      if (states[states.length - 1]?.split(' ')[1] !== st)
        states.push(`${Math.round((Date.now() - t0) / 1000)}s ${st}`);
      await page.waitForTimeout(500);
    }
    console.log(states.join('\n'));
    const seq = states
      .map((x) => x.split(' ')[1].split('@')[0])
      .filter((x, i, a) => x !== a[i - 1]);
    // one pause (from "pause" — the sentence before it never paused anything), played again, then stopped
    expect(seq.filter((x) => x === 'paused')).toHaveLength(1);
    expect(seq.slice(seq.indexOf('paused'))).toEqual(['paused', 'playing', 'off']);
    expect(states.some((x) => x.endsWith('@1.5'))).toBe(true); // "faster"
    const fresh = (
      (await (await request.get(`${pv}/session/${MAIN}/message`)).json()) as M[]
    ).slice(before);
    const said = fresh
      .filter((m) => m.info.role === 'user')
      .map((m) => m.parts.map((p) => p.text || '').join(' '));
    expect(said.filter((t) => /lighthouse/i.test(t))).toHaveLength(1);
    expect(
      said.some((t) =>
        /\b(pause|continue|faster|slower|stop|interesting)\b/i.test(t.replace(/\[ctx:.*\]/, ''))
      )
    ).toBe(false);
    await page.goto('about:blank');
  });
}

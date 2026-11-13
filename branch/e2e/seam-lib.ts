import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { type Page, expect } from '@playwright/test';
import { diag } from './mainframe-c-lib';

/** hf-ptt-unify seam lib — shared by the three per-mic seam spec files.
 *  REAL AUDIO: the browser mic IS a WAV (chromium
 *  --use-file-for-fake-audio-capture); %noloop one-shots + loopers,
 *  synthesized through the stage's own TTS leg. The only fake left: the
 *  phone's speaker output is simulated by feeding its WAV as the mic
 *  (human-fidelity-sim-design.md). SEAM PROOF: the agent's ONE machinery
 *  logs "commit_user_turn: start (ptt flush)". */

export const AUDIO_DIR = '/tmp/seam-audio';
export const PCM_RATE = 24000;

export function pcmWav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * 3.2));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(PCM_RATE, 24);
  hdr.writeUInt32LE(PCM_RATE * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

function synthWav(text: string, out: string, trailingSilenceSec = 2): void {
  const r = spawnSync(
    'curl',
    [
      '-s',
      '-X',
      'POST',
      `${process.env.PW_BASE_URL || 'http://127.0.0.1:8096'}/api/tts/stream`,
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify({ text, lang: 'en', sid: 'seam-synth' }),
    ],
    { encoding: 'buffer', timeout: 90_000, maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length < 1000)
    throw new Error(`synth failed: ${r.stderr?.toString().slice(0, 120) || 'empty'}`);
  const raw = Buffer.from(r.stdout);
  const samples = new Float32Array(raw.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = raw.readInt16LE(i * 2) / 32768;
  const silence = new Float32Array(PCM_RATE * trailingSilenceSec);
  mkdirSync(AUDIO_DIR, { recursive: true });
  writeFileSync(out, pcmWav(Float32Array.from([...samples, ...silence])));
}

export const W_USER = `${AUDIO_DIR}/seam-user.wav`;
export const W_ECHO = `${AUDIO_DIR}/seam-echo.wav`;
export const W_ASK = `${AUDIO_DIR}/seam-ask.wav`;
export const USER_PHRASE = 'seam override check';
export const ECHO_PHRASE =
  'the weather is clear today, the sky is bright and clear, the sun is warm today';
export const ASK_PHRASE = 'what is the seam answer token';

export function synthAll(): void {
  synthWav(`${USER_PHRASE} ${USER_PHRASE} ${USER_PHRASE}`, W_USER);
  // one-shots are LONG (phrase x3, ~20s speech + fat silence tail): the
  // browser join takes 5-10s and the deck must still be speaking when the
  // WAV arrives, or the barge never fires (flake root, 13:51 run)
  synthWav(`${ECHO_PHRASE}, ${ECHO_PHRASE}, ${ECHO_PHRASE}`, W_ECHO, 8);
  synthWav(`${ASK_PHRASE}, ${ASK_PHRASE}, ${ASK_PHRASE}`, W_ASK, 8);
}

export function micArgs(wav: string, loop = true): string[] {
  const spec = loop ? wav : `${wav}%noloop`;
  return [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${spec}`,
    ...(process.env.PW_JITLESS ? ['--js-flags=--jitless'] : []),
  ];
}

/** RIG LAW: the agent unit is named by SEAM_AGENT_UNIT (a scratch agent bound to the sim
 *  stage) — never defaulted to the live lk-agent-unify. Unset = the spec cannot judge. */
function agentLog(needle: string, sinceMin: number): number {
  const unit = process.env.SEAM_AGENT_UNIT;
  if (!unit) throw new Error('SEAM_AGENT_UNIT unset: no scratch agent on the sim stage (see hf-sim-r1.md TODO-1)');
  const r = spawnSync(
    'journalctl',
    ['--user', '-u', unit, '--since', `-${sinceMin} min`, '--no-pager', '-o', 'cat'],
    { encoding: 'utf8', timeout: 15_000 }
  );
  return (r.stdout || '').split('\n').filter((l) => l.includes(needle)).length;
}
export const flushLines = (m = 6) => agentLog('commit_user_turn: start (ptt flush)', m);
export const vetoLines = (m = 6) => agentLog('ECHO VETO', m);

export async function freshRoom(page: Page): Promise<string> {
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
  await page.goto(`/session/${name}${j.id ? `?id=${j.id}` : ''}`);
  await page.getByTestId('composer-mic').tap();
  await expect(page.getByTestId('free-phase')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('free-strip')).not.toContainText('connecting', {
    timeout: 30_000,
  });
  // polls MUST use the id: the proxy's slug lookup walks a CAPPED session
  // list — a fresh session falls outside it and every message read 0s
  return j.id || name;
}

export async function sendUserTurn(page: Page, slug: string, text: string): Promise<void> {
  const r = await page.request.post(`/api/session/${slug}/messages`, {
    data: { text, async: true },
  });
  expect(r.ok()).toBe(true);
}

export async function userMsgCount(page: Page, sessionId: string): Promise<number> {
  // by ID straight from the brain (the proxy slug read is capped-list-bound)
  const r = await page.request.get(
    `${process.env.SEAM_BRAIN || 'http://127.0.0.1:4111'}/session/${sessionId}/message?limit=50`
  );
  const j = (await r.json()) as { info: { role: string } }[];
  return (Array.isArray(j) ? j : []).filter((m) => m.info.role === 'user').length;
}

export async function waitForAssistant(
  page: Page,
  sessionId: string,
  timeoutMs = 180_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await page.request.get(
          `${process.env.SEAM_BRAIN || 'http://127.0.0.1:4111'}/session/${sessionId}/message?limit=20`
        );
        const j = (await r.json()) as { info: { role: string } }[];
        return (Array.isArray(j) ? j : []).filter((m) => m.info.role === 'assistant').length;
      },
      { timeout: timeoutMs, intervals: [3_000, 5_000] }
    )
    .toBeGreaterThan(0);
}

export const W_SELF = `${AUDIO_DIR}/seam-self.wav`;
/** SELF-VOICE (ledger 11-09 19:56Z + 20:05Z): our own LAST reply, re-entering the mic AFTER
 *  playback ended. 12 s of leading silence = the deck is done speaking before the audio lands
 *  (the veto window is the reply's text + audio TAIL, not only the unplayed remainder). */
export function synthSelf(replyText: string): void {
  synthWav(replyText, W_SELF, 2);
  // prepend the silence: re-read, pad, rewrite
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const b = readFileSync(W_SELF);
  const pcm = b.subarray(44);
  const pad = Buffer.alloc(PCM_RATE * 2 * 12);
  const all = Buffer.concat([pad, pcm]);
  const samples = new Float32Array(all.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = all.readInt16LE(i * 2) / 32768 / 3.2;
  writeFileSync(W_SELF, pcmWav(samples));
}

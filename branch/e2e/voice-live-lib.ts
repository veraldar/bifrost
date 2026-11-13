/** Shared by the REAL voice specs (no mock): Chrome plays a spoken wav as the microphone, the
 *  real voice agent transcribes it, the root answers, and the app speaks the answer through
 *  /api/tts/stream. Point at a stack whose app dispatches its OWN agent — the root-coord preview:
 *  PW_BASE_URL=http://127.0.0.1:8101 E2E_OC_URL=http://127.0.0.1:4101. */
import { join } from 'node:path';
import { type APIRequestContext, type Page, devices, test } from '@playwright/test';

export const PV = process.env.E2E_OC_URL || 'http://127.0.0.1:4101';

/** a Pixel 7 whose microphone plays `wav` (one per spec file: the mic is a launch option) */
export function realMic(wav: string) {
  test.use({
    ...devices['Pixel 7'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${join(__dirname, 'fixtures', wav)}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  });
}

export type M = {
  info: { role: string; modality?: string; time: { completed?: number } };
  parts: { type: string; text?: string }[];
};
export const textOf = (m: M) => m.parts.map((p) => p.text || '').join(' ');
export const msgs = async (r: APIRequestContext, id: string, base = PV) =>
  (await (await r.get(`${base}/session/${id}/message`)).json()) as M[];
export const mainId = async (r: APIRequestContext, base = PV) =>
  ((await (await r.get(`${base}/session`)).json()) as { id: string; title: string }[]).find(
    (x) => x.title === '[MAIN]'
  )!.id;
/** what the voice agent sent: marked voice (root brains) or tagged hands-free (opencode) */
export const voiceTurns = (ms: M[]) =>
  ms.filter(
    (m) =>
      m.info.role === 'user' &&
      (m.info.modality === 'voice' || textOf(m).includes('mode=hands-free'))
  );
/** each voice turn and the assistant reply that follows it (null = not answered yet) */
export const answered = (ms: M[]) =>
  ms.flatMap((m, i) =>
    voiceTurns([m]).length
      ? [{ said: textOf(m), reply: ms[i + 1]?.info.role === 'assistant' ? ms[i + 1] : null }]
      : []
  );

/** every reply the app spoke: /api/tts/stream calls, their status and the text sent */
export function ttsLog(page: Page) {
  const log: { status: number; text: string }[] = [];
  page.on('response', (r) => {
    if (!r.url().includes('/api/tts/stream')) return;
    let text = '';
    try {
      text = String(r.request().postDataJSON()?.text || '');
    } catch {
      /* not json */
    }
    log.push({ status: r.status(), text });
  });
  return log;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/** was this reply spoken? a TTS call (200) whose text shares the reply's opening words */
export const spoken = (reply: M, log: { status: number; text: string }[]) => {
  const head = norm(textOf(reply)).split(' ').slice(0, 4).join(' ');
  return log.some((t) => t.status === 200 && norm(t.text).includes(head));
};

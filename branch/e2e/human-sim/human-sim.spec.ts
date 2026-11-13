import { type Page, test } from '@playwright/test';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { PCM_RATE, pcmWav } from '../seam-lib';
import { type HMark, installHsim, marks } from './hsim-init';

/** HUMAN-SIM (human-sim-plan ④): one spec, every corpus/*.yaml a case. Each case emits a TSV row
 *  id·verdict·signature·evidence — the test itself never fails; scripts/human-sim-gate.sh diffs the TSV
 *  against expect_current. Verdicts: GREEN | RED (gold signature seen, rig preconditions held) |
 *  RIG (a precondition failed — a rig error is never a pass and never a RED). */
type Turn = { via?: 'text' | 'wav'; say?: string; hold_ms?: number };
type Case = {
  id: string; bug: string; gold: string; mode: 'ptt' | 'hf'; turns: Turn[];
  assert: { kind: string; params: Record<string, number | string> }; expect_current: 'RED' | 'GREEN';
};
const BRAIN = process.env.SEAM_BRAIN || 'http://127.0.0.1:4111';
const OUT = process.env.HSIM_OUT || '/tmp/hsim/out.tsv';
const SHOTS = process.env.HSIM_SHOTS || '/tmp/hsim/shots';
const SEED = process.env.HSIM_SEED || '';
const AGENT = process.env.SEAM_AGENT_UNIT || '';
const dir = `${__dirname}/corpus`;
const cases = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
  .map((f) => load(readFileSync(`${dir}/${f}`, 'utf8')) as Case)
  .filter((c) => !process.env.HSIM_ONLY || process.env.HSIM_ONLY.split(',').includes(c.id));

class Rig extends Error {}
const rig = (m: string): never => { throw new Rig(m); };
type Res = { verdict: 'GREEN' | 'RED'; sig: string; ev: string };
const ok = (ev: string): Res => ({ verdict: 'GREEN', sig: '-', ev });
const red = (sig: string, ev: string): Res => ({ verdict: 'RED', sig, ev });

test.use({
  viewport: { width: 360, height: 780 }, hasTouch: true,
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(process.env.PW_JITLESS ? ['--js-flags=--jitless'] : [])] },
});

async function msgs(page: Page, sid: string): Promise<{ role: string; text: string }[]> {
  const r = await page.request.get(`${BRAIN}/session/${sid}/message?limit=50`);
  const j = (await r.json()) as { info: { role: string; time?: { completed?: number } }; parts?: { type: string; text?: string }[] }[];
  // the brain creates the assistant message at once as an empty in-flight placeholder: only a completed one is a reply
  return (Array.isArray(j) ? j : []).filter((m) => m.info.role !== 'assistant' || m.info.time?.completed).map((m) => ({ role: m.info.role, text: (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ') }));
}
const count = async (page: Page, sid: string, role: string) => (await msgs(page, sid)).filter((m) => m.role === role).length;
async function waitCount(page: Page, sid: string, role: string, n: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await count(page, sid, role)) >= n) return; await page.waitForTimeout(1000); }
  rig(`brain never reached ${n} ${role} msgs in ${ms}ms`);
}
function commitLines(sinceMin = 3): number {
  if (!AGENT) return -1;
  const r = spawnSync('journalctl', ['--user', '-u', AGENT, '--since', `-${sinceMin} min`, '--no-pager', '-o', 'cat'], { encoding: 'utf8', timeout: 15_000 });
  return (r.stdout || '').split('\n').filter((l) => l.includes('commit_user_turn: start')).length;
}
/** the seam-agent logs "room 'X' ready" once linked to the human — speech before that is lost audio */
async function agentReady(page: Page, name: string): Promise<void> {
  if (!AGENT) return;
  for (let i = 0; i < 60; i++) {
    const r = spawnSync('journalctl', ['--user', '-u', AGENT, '--since', '-5 min', '--no-pager', '-o', 'cat'], { encoding: 'utf8', timeout: 15_000 });
    if ((r.stdout || '').includes(`room '${name}' ready`)) return;
    await page.waitForTimeout(1000);
  }
  rig(`agent ${AGENT} never logged room '${name}' ready in 60s`);
}
async function wavFor(page: Page, text: string): Promise<string> {
  const f = `${__dirname}/corpus/wav/${createHash('sha1').update(text).digest('hex').slice(0, 16)}.wav`;
  mkdirSync(`${__dirname}/corpus/wav`, { recursive: true });
  try { readFileSync(f); } catch {
    const r = spawnSync('curl', ['-s', '-X', 'POST', `${process.env.PW_BASE_URL || 'http://127.0.0.1:8096'}/api/tts/stream`, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ text, lang: 'en', sid: 'hsim-synth' })], { encoding: 'buffer', timeout: 90_000, maxBuffer: 64 << 20 });
    if (!r.stdout || r.stdout.length < 1000) rig('tts synth failed');
    const raw = Buffer.from(r.stdout); const s = new Float32Array(raw.length / 2);
    for (let i = 0; i < s.length; i++) s[i] = raw.readInt16LE(i * 2) / 32768;
    writeFileSync(f, pcmWav(Float32Array.from([...s, ...new Float32Array(PCM_RATE * 2)])));
  }
  await page.route('**/__hsim/turn.wav', (rt) => rt.fulfill({ body: readFileSync(f), contentType: 'audio/wav' }));
  return '/__hsim/turn.wav';
}
async function touch(page: Page, x: number, y: number, hold: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(hold);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function room(page: Page): Promise<{ name: string; sid: string }> {
  const name = `e2e-hsim-${Date.now().toString(36)}`;
  const r = await page.request.post('/api/session', { data: { name } });
  if (!r.ok()) rig('session create ' + r.status());
  return { name, sid: ((await r.json()) as { id: string }).id };
}
async function enterHf(page: Page, name: string, sid: string): Promise<void> {
  await page.goto(`/session/${name}?id=${sid}`);
  await page.getByTestId('composer-mic').tap().catch(() => rig('composer-mic not tappable'));
  await page.getByTestId('free-phase').waitFor({ timeout: 15_000 }).catch(() => rig('free-phase never appeared'));
  const t = Date.now();
  while (Date.now() - t < 30_000 && (await page.getByTestId('free-strip').innerText()).includes('connecting')) await page.waitForTimeout(500);
  const t2 = Date.now();
  while (Date.now() - t2 < 25_000 && !(await marks(page)).some((x) => x.k === 'mic' && x.v === 'on')) await page.waitForTimeout(500);
  if (!(await marks(page)).some((x) => x.k === 'mic' && x.v === 'on')) rig('hsim mic swap not live (no mic=on mark in 25s)');
  await page.waitForTimeout(1500); // gesture ghost guard
}
const commitTap = async (page: Page) => { const b = (await page.getByTestId('free-phase').boundingBox())!; await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
const first = (m: HMark[], k: string, p: (v: string) => boolean, after = 0) => m.find((x) => x.k === k && x.t >= after && p(x.v));
const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean));
const jac = (a: string, b: string) => { const A = toks(a), B = toks(b); let i = 0; A.forEach((t) => B.has(t) && i++); return i / (A.size + B.size - i || 1); };

/** text turn in hands-free: the dock tap commits ("over" → processing), the turn is posted as the agent would. */
async function textTurn(page: Page, name: string, sid: string, say: string): Promise<number> {
  await commitTap(page);
  const t = Date.now();
  const r = await page.request.post(`/api/session/${name}/messages`, { data: { text: say, async: true } });
  if (!r.ok()) rig('post turn ' + r.status());
  await waitCount(page, sid, 'user', 1, 15_000);
  return t;
}
type Rec = { t0: number; t1: number; text: string };
/** the played record of THIS reply (its /api/tts text) — never an earlier cue/chime element that also ended */
async function replyPlayed(page: Page, reply: string, ms: number): Promise<Rec> {
  const key = reply.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
  await page.waitForFunction((k) => (window as unknown as { __hsim: { played: Rec[] } }).__hsim.played.some((p) => p.t1 && p.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(k)), key, { timeout: ms }).catch(() => rig(`reply "${key}" never played to its end`));
  return page.evaluate((k) => (window as unknown as { __hsim: { played: Rec[] } }).__hsim.played.filter((p) => p.t1 && p.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(k)).pop()!, key);
}
const mockReply = async (page: Page, sid: string) => { await waitCount(page, sid, 'assistant', 1, 120_000); return (await msgs(page, sid)).filter((m) => m.role === 'assistant').pop()!.text; };

const RUN: Record<string, (page: Page, c: Case) => Promise<Res>> = {
  async 'footer-text'(page, c) {
    const { name, sid } = await room(page);
    await page.goto(`/session/${name}?id=${sid}`);
    const mic = page.getByRole('button', { name: 'push to talk' });
    await mic.waitFor({ timeout: 30_000 }).catch(() => rig('push to talk button missing'));
    if (SEED === 'footer-text') await page.evaluate(() => { const d = document.createElement('div'); d.setAttribute('data-testid', 'free-strip'); d.textContent = 'heard…'; document.querySelector('main')?.appendChild(d); });
    const b = (await mic.boundingBox())!;
    const seen: string[] = [];
    const sample = setInterval(() => { void page.evaluate(() => [...document.querySelectorAll('[data-testid="free-strip"],[data-testid="free-phase"],footer,.oz-dock')].map((e) => (e as HTMLElement).innerText).join(' | ')).then((s) => seen.push(s)).catch(() => {}); }, 150);
    await touch(page, b.x + b.width / 2, b.y + b.height / 2, c.turns[0].hold_ms || 1500);
    clearInterval(sample);
    if (!seen.length) rig('no footer samples taken');
    const hit = seen.find((s) => new RegExp(String(c.assert.params.forbid), 'i').test(s));
    return hit ? red(c.gold, `"${hit.slice(0, 80)}"`) : ok(`${seen.length} samples, no /${c.assert.params.forbid}/`);
  },
  async 'mic-rearm'(page, c) {
    const { name, sid } = await room(page);
    await installHsimSeed(page);
    await enterHf(page, name, sid);
    await textTurn(page, name, sid, c.turns[0].say!);
    const reply = await mockReply(page, sid);
    const t1 = (await replyPlayed(page, reply, 30_000)).t1;
    await page.waitForTimeout(Number(c.assert.params.within_ms) + 500);
    const m = await marks(page);
    const cyc = [...m].reverse().find((x) => x.k === 'cycle' && x.t <= t1 + Number(c.assert.params.within_ms));
    const mic = [...m].reverse().find((x) => x.k === 'mic' && x.t <= t1 + Number(c.assert.params.within_ms));
    const tl = m.filter((x) => ['cycle', 'deck', 'mic'].includes(x.k) && x.t >= t1 - 4000).map((x) => `${x.k}=${x.v}@${x.t - t1}`).join(' ');
    return cyc?.v === 'listening' && mic?.v === 'on' ? ok(`cycle=${cyc.v} mic=${mic.v} ≤${c.assert.params.within_ms}ms after t1 [${tl}]`) : red(c.gold, `cycle=${cyc?.v} mic=${mic?.v} [${tl}]`);
  },
  async 'dup-commit'(page, c) {
    const { name, sid } = await room(page);
    await installHsim(page);
    await enterHf(page, name, sid);
    await agentReady(page, name);
    const before = commitLines();
    // the human's side: speak, ending with the radio keyword "over" — the agent STTs it and commits by itself
    await page.evaluate(async (u) => (window as unknown as { __hsim: { say: (u: string) => Promise<number> } }).__hsim.say(u), await wavFor(page, c.turns[0].say!));
    await waitCount(page, sid, 'user', 1, 45_000);
    if (SEED === 'dup-commit') await page.request.post(`/api/session/${name}/messages`, { data: { text: 'seed duplicate', async: true } });
    await page.waitForTimeout(Number(c.turns[0].hold_ms || 6000));
    const n = await count(page, sid, 'user');
    const lines = commitLines() - before;
    const dom = await page.getByText('(you)', { exact: true }).count();
    const got = `brain user msgs=${n} DOM bubbles=${dom} commit lines=${lines}`;
    if (!dom) rig('no user bubble found in the DOM ((you) label) — ' + got);
    if (lines < 1) rig('no commit_user_turn line in the agent journal — ' + got);
    return n === Number(c.assert.params.expect) && dom === n && lines === n ? ok(got) : red(c.gold, got);
  },
  async 'never-spoken'(page, c) {
    const { name, sid } = await room(page);
    await installHsim(page);
    if (SEED === 'never-spoken') await page.route('**/api/tts**', (rt) => rt.fulfill({ status: 500, body: 'seed' }));
    await enterHf(page, name, sid);
    await textTurn(page, name, sid, c.turns[0].say!);
    await waitCount(page, sid, 'assistant', 1, 60_000);
    const tA = Date.now();
    await page.waitForTimeout(Number(c.assert.params.within_ms));
    const m = await marks(page);
    const tts = first(m, 'tts.fetch', (v) => v.startsWith('resp 200'), tA - 3000);
    const play = first(m, 'audio.play', (v) => v === 'resolved', tA - 3000);
    const deck = first(m, 'deck', (v) => v === 'playing', tA - 3000);
    return tts && play && deck ? ok(`tts+play+deck within ${(deck.t - tA)}ms`) : red(c.gold, `tts=${!!tts} play=${!!play} deck=${!!deck}; cycle=${[...m].reverse().find((x) => x.k === 'cycle')?.v}`);
  },
  async 'self-echo'(page, c) {
    const { name, sid } = await room(page);
    await installHsim(page);
    await page.addInitScript(() => (window as unknown as { __hsim: { echo: (b: boolean) => void } }).__hsim.echo(true));
    await enterHf(page, name, sid);
    await agentReady(page, name);
    await textTurn(page, name, sid, c.turns[0].say!);
    const reply = await mockReply(page, sid);
    const pl = await replyPlayed(page, reply, 40_000);
    // route proof: the mic track itself must have carried the speaker's energy while the reply played
    const lv = await page.evaluate(([a, b]) => (window as unknown as { __hsim: { level: (a: number, b: number) => number } }).__hsim.level(a, b), [pl.t0, pl.t1]);
    if (lv < 0.01) rig(`speaker→mic tap not routed: mic peak rms ${lv.toFixed(4)} during playback`);
    await page.waitForTimeout(Number(c.assert.params.window_ms));
    const us = (await msgs(page, sid)).filter((m) => m.role === 'user').slice(1);
    // the rig's loopback is digital (no acoustic AEC), so echo turns reaching the brain are EXPECTED — the product's
    // law (pwa-flow-fix 11-03) is that the echo's answer stays unspoken. RED = an echo-shaped turn (its tokens ⊂ the reply's)
    // was answered ALOUD: a played record after the reply that is not the reply.
    const contain = (a: string, b: string) => { const A = toks(a), B = toks(b); let i = 0; A.forEach((t) => B.has(t) && i++); return A.size ? i / A.size : 0; };
    const echoes = us.filter((u) => contain(u.text, reply) >= Number(c.assert.params.jaccard) + 0.3 || jac(u.text, reply) >= Number(c.assert.params.jaccard));
    const key = reply.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
    const after = (await page.evaluate(() => (window as unknown as { __hsim: { played: Rec[] } }).__hsim.played.slice())).filter((p) => p.t0 > pl.t1 && p.text && !p.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(key));
    const ev = `${us.length} extra user turns [${us.map((u) => `"${u.text.slice(0, 40)}"`).join('; ')}], ${echoes.length} echo-shaped, ${after.length} answered aloud; mic peak rms ${lv.toFixed(3)} during playback`;
    return echoes.length && after.length ? red(c.gold, ev) : ok(ev);
  },
  async 'silent-wait'(page, c) {
    const { name, sid } = await room(page);
    await installHsim(page);
    await enterHf(page, name, sid);
    const t0 = await textTurn(page, name, sid, c.turns[0].say!);
    await page.waitForTimeout(Number(c.assert.params.span_ms) + 4000);
    const m = (await marks(page)).filter((x) => x.t >= t0 && x.k !== 'sse' && x.k !== 'warn' && x.k !== 'mic');
    const asst = await count(page, sid, 'assistant');
    if (asst > 0) rig('reply arrived inside the wait window — mock delay not applied');
    const last = Math.max(...m.map((x) => x.t), t0);
    const gap = Math.max(last - t0, 0);
    const span = Number(c.assert.params.span_ms);
    // dead air = the whole [t0+gap … now] stretch had no mark (phase/cycle change, tts, audio)
    return Date.now() - last > span ? red(c.gold, `no phase/audio mark for ${Date.now() - last}ms after commit (last mark +${gap}ms)`) : ok(`marks kept coming (last ${Date.now() - last}ms ago)`);
  },
};
async function installHsimSeed(page: Page): Promise<void> {
  await installHsim(page);
  if (SEED === 'mic-rearm')
    await page.addInitScript(() => { setInterval(() => { const h = (window as unknown as { __hsim?: { played: { t1: number; text: string }[]; tracks?: MediaStreamTrack[] } }).__hsim; if (h?.played.some((p) => p.t1 && p.text)) h.tracks?.forEach((t) => (t.enabled = false)); }, 50); void 0; });
}

mkdirSync(SHOTS, { recursive: true });
for (const c of cases) {
  test(`human-sim ${c.id}`, async ({ page }) => {
    test.setTimeout(240_000);
    if (c.mode === 'ptt') await installHsim(page);
    let r: Res;
    try {
      r = await RUN[c.assert.kind](page, c);
    } catch (e) {
      r = { verdict: 'RED', sig: 'RIG', ev: String((e as Error).message).slice(0, 160) };
      if (!(e instanceof Rig)) r.ev = 'unexpected: ' + r.ev;
    }
    const shot = `${SHOTS}/${c.id}.png`;
    await page.screenshot({ path: shot }).catch(() => {});
    const verdict = r.sig === 'RIG' ? 'RIG' : r.verdict;
    appendFileSync(OUT, [c.id, verdict, r.sig, `${r.ev.replace(/[\t\n]/g, ' ')} @ ${shot}`].join('\t') + '\n');
    console.log(`[hsim] ${c.id} ${verdict} ${r.sig} ${r.ev}`);
  });
}

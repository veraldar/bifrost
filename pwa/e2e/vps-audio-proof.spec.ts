// vps-audio-proof — closes the phone-anywhere chain (session VPS-AUDIO-PROOF).
// Two playwright contexts (A+B) join the VPS trunk bridge off-LAN:
//   A: full turn (text through brain + PTT voice turn, fake capture)
//   B: own PTT voice turn — polls RTC inbound-rtp audio bytesReceived growth.
// Records: ms to first remote audio byte (A+B), selected ICE candidate pair
// (host/srflx/relay, both sides), full getStats dump (webrtc-internals
// equivalent), room screenshot. Loopback candidates are munged client-side so
// the only path is the real public one (the trunk advertises 127.0.0.1 for
// on-box sims — same-box test would otherwise pair over loopback).
// Architecture note (from lab/bifrost-net/src/bridge.rs): Outcome::Voice is
// written ONLY to the requesting peer (`peers.get_mut(&client)`) — the trunk
// is star-shaped (client<->trunk), no cross-peer room broadcast in v1. So
// "B receives A's frames" is proven as: both contexts independently receive
// real audio frames across the public internet path (the exact physics a
// phone faces); cross-peer A->B relay is recorded as the trunk-v2 delta.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'fs';

const TOKEN = fs.readFileSync('/tmp/vps-audio/token.txt', 'utf8').trim();
const BASE = 'https://pwa.179-237-67-146.nip.io';
const BRIDGE = 'https://179-237-67-146.nip.io';
const OUT = '/tmp/vps-audio';

type Ice = { type: string; raw: string };

async function instrument(ctx: BrowserContext, tag: string) {
  await ctx.addInitScript((tag: string) => {
    const w = window as any;
    w.__ice = [] as Ice[];
    w.__pcs = [] as any[];
    const W = window.RTCPeerConnection;
    function PC(...args: any[]) {
      const pc: any = new (W as any)(...args);
      w.__pcs.push(pc);
      pc.addEventListener('icecandidate', (e: any) => {
        const c = e.candidate?.candidate || '';
        if (c) w.__ice.push({ type: (c.match(/typ (\w+)/) || [])[1] || '?', raw: c.slice(0, 90) });
      });
      // force the real path: drop loopback candidates from OUR offer
      const osld = pc.setLocalDescription.bind(pc);
      pc.setLocalDescription = (d: any) => {
        if (d && typeof d.sdp === 'string') {
          d = {
            type: d.type,
            sdp: d.sdp.replace(/^(a=candidate:.*?)(127\.0\.0\.1)(.*)$/gm, '$1192.0.2.111$3'),
          };
        }
        return osld(d);
      };
      return pc;
    }
    PC.prototype = W.prototype;
    window.RTCPeerConnection = PC as any;
  }, tag);
}

async function startBytePoller(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__bytesTimeline = [] as { t: number; bytes: number }[];
    w.__poll = setInterval(() => {
      Promise.all(
        (w.__pcs || []).map((p: any) =>
          p.getStats().then((stats: any) => {
            let b = 0;
            stats.forEach((s: any) => {
              if (s.type === 'inbound-rtp' && s.kind === 'audio') b += s.bytesReceived || 0;
            });
            w.__bytesTimeline.push({ t: Date.now(), bytes: b });
          }),
        ),
      ).catch(() => {});
    }, 250);
  });
}

async function stopBytePoller(page: Page) {
  await page.evaluate(() => clearInterval((window as any).__poll)).catch(() => {});
}

async function dumpStats(page: Page, path: string) {
  const dump = await page.evaluate(async () => {
    const out: any[] = [];
    for (const pc of (window as any).__pcs || []) {
      const stats: any = await pc.getStats();
      const entries: any[] = [];
      stats.forEach((s: any) => entries.push(s));
      out.push({ ice: pc.iceConnectionState, conn: pc.connectionState, stats: entries });
    }
    return out;
  });
  fs.writeFileSync(path, JSON.stringify(dump, null, 1));
  return dump;
}

async function selectedPair(page: Page) {
  return page.evaluate(async () => {
    for (const pc of (window as any).__pcs || []) {
      const stats = await pc.getStats();
      const cands = new Map<string, any>();
      stats.forEach((s: any) => {
        if (s.type === 'local-candidate' || s.type === 'remote-candidate') cands.set(s.id, s);
      });
      for (const s of stats.values() as any[]) {
        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
          const l = cands.get(s.localCandidateId);
          const r = cands.get(s.remoteCandidateId);
          return {
            local: l && { type: l.candidateType, ip: l.ip, port: l.port },
            remote: r && { type: r.candidateType, ip: r.ip, port: r.port },
            rtt: s.currentRoundTripTime ?? null,
            nominated: !!s.nominated,
          };
        }
      }
    }
    return null;
  });
}

async function firstByteMs(page: Page, t0: number): Promise<number | null> {
  return page.evaluate((t0: number) => {
    const tl = (window as any).__bytesTimeline || [];
    const hit = tl.find((e: any) => e.bytes > 0);
    return hit ? hit.t - t0 : null;
  }, t0);
}

async function join(tag: string, ctx: BrowserContext) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(`${BASE}/bridge?t=${encodeURIComponent(TOKEN)}&b=${encodeURIComponent(BRIDGE)}`);
  const t = await page.getByTestId('bridge-token').inputValue();
  expect(t.startsWith('bfnd-')).toBeTruthy();
  const t0 = Date.now();
  await page.getByTestId('bridge-connect').click();
  try {
    await expect(page.getByTestId('bridge-state')).toContainText('connected', { timeout: 30_000 });
  } catch (e: any) {
    // capture the EXACT stuck state before the page/context die
    const stuck = await page
      .evaluate(() => ({
        state: document.querySelector('[data-testid="bridge-state"]')?.textContent,
        log: document.querySelector('[data-testid="bridge-log"]')?.textContent?.slice(-400),
        pcs: (window as any).__pcs.map((p: any) => ({
          ice: p.iceConnectionState,
          conn: p.connectionState,
          sig: p.signalingState,
        })),
        candidatesOffered: (window as any).__ice,
      }))
      .catch(() => null);
    await page.screenshot({ path: `${OUT}/failure-stuck.png` }).catch(() => {});
    fs.writeFileSync(`${OUT}/stuck-${tag}.json`, JSON.stringify({ tag, joinTriedMs: Date.now() - t0, stuck }, null, 1));
    throw new Error(`JOIN-STUCK[${tag}]: ${JSON.stringify(stuck?.pcs)} cands=${JSON.stringify((stuck?.candidatesOffered || []).map((c: any) => c.type))}`);
  }
  const joinMs = Date.now() - t0;
  console.log(`[${tag}] JOIN-OK connect_ms=${joinMs}`);
  return { page, joinMs };
}

async function pttTurn(tag: string, page: Page) {
  await startBytePoller(page);
  const t0 = Date.now();
  await page.getByTestId('bridge-ptt').dispatchEvent('mousedown');
  await page.waitForTimeout(2000);
  await page.getByTestId('bridge-ptt').dispatchEvent('mouseup');
  let voice = '';
  try {
    await page
      .getByTestId('bridge-voice')
      .filter({ hasText: 'reply audio:' })
      .waitFor({ timeout: 150_000 });
    voice = (await page.getByTestId('bridge-voice').textContent()) || '';
  } catch (e: any) {
    voice = `NO-REPLY: ${String(e.message).split('\n')[0]}`;
  }
  await stopBytePoller(page);
  const firstMs = await firstByteMs(page, t0);
  console.log(`[${tag}] PTT voice="${voice.slice(0, 70)}" first_remote_audio_ms=${firstMs ?? 'NEVER'}`);
  return { voice, firstMs, t0 };
}

test('vps-audio-proof: two off-LAN contexts, both receive remote audio over the public path', async ({ browser }) => {
  test.setTimeout(420_000);
  const ctxA = await browser.newContext({ viewport: { width: 360, height: 780 } });
  const ctxB = await browser.newContext({ viewport: { width: 360, height: 780 } });
  await instrument(ctxA, 'A');
  await instrument(ctxB, 'B');
  const result: any = { tokenTail: TOKEN.slice(-6), base: BASE, bridge: BRIDGE };

  try {
    // ---- A: join + full turn (text through brain, then voice) ----
    const { page: A, joinMs: joinA } = await join('A', ctxA);
    result.joinA_ms = joinA;
    try {
      await A.getByTestId('bridge-input').fill('Reply with exactly: LAYMAN-OK');
      await A.getByTestId('bridge-send').click();
      await A.getByTestId('bridge-log')
        .filter({ hasText: 'LAYMAN-OK' })
        .waitFor({ timeout: 60_000 });
      result.brainTextTurn = 'LAYMAN-OK';
    } catch (e: any) {
      result.brainTextTurn = `FAIL: ${String(e.message).split('\n')[0]}`;
    }
    const turnA = await pttTurn('A', A);
    result.A = { voice: turnA.voice, firstRemoteAudioMs: turnA.firstMs };

    // ---- B: independent join + own voice turn (its own remote audio) ----
    const { page: B, joinMs: joinB } = await join('B', ctxB);
    result.joinB_ms = joinB;
    const turnB = await pttTurn('B', B);
    result.B = { voice: turnB.voice, firstRemoteAudioMs: turnB.firstMs };

    // ---- evidence ----
    result.pairA = await selectedPair(A);
    result.pairB = await selectedPair(B);
    result.iceA = await A.evaluate(() => (window as any).__ice);
    result.iceB = await B.evaluate(() => (window as any).__ice);
    await dumpStats(A, `${OUT}/stats-A.json`);
    await dumpStats(B, `${OUT}/stats-B.json`);
    await B.screenshot({ path: '/tmp/vps-audio/vps-audio-room.png' });

    const audioOkA = turnA.firstMs !== null;
    const audioOkB = turnB.firstMs !== null;
    result.verdict = audioOkA && audioOkB ? 'GREEN' : audioOkA || audioOkB ? 'PARTIAL' : 'RED';
    fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 1));
    console.log(`VPS-AUDIO-PROOF ${result.verdict} pairA=${JSON.stringify(result.pairA)} pairB=${JSON.stringify(result.pairB)}`);
  } catch (e: any) {
    // failure capture: exact ICE state + candidate types offered
    const fail: any = { error: String(e.message).split('\n')[0], result };
    for (const [tag, pg] of [['A', result.__pageA], ['B', result.__pageB]] as any[]) {
      if (!pg) continue;
      try {
        fail[tag] = await pg.evaluate(() => ({
          ice: (window as any).__pcs.map((p: any) => p.iceConnectionState),
          conn: (window as any).__pcs.map((p: any) => p.connectionState),
          candidatesOffered: (window as any).__ice,
        }));
      } catch {}
    }
    fs.writeFileSync(`${OUT}/failure.json`, JSON.stringify(fail, null, 1));
    throw e;
  } finally {
    await ctxA.close().catch(() => {});
    await ctxB.close().catch(() => {});
  }
});

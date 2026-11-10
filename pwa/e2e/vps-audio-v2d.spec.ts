// v2d — two off-LAN contexts on the VPS bridge: SFU-lite A→B relay proof.
// Same rig as v2b2 (playwright ×2, fake capture, jitless, munged loopback).
// v2d additions vs v2b2:
//   (a) B joins FIRST and keeps a byte-poller running ACROSS A's whole turn —
//       proves A's media actually reaches B over the public path (SFU-lite:
//       relay forwards every peer's media to all OTHER peers, relay.rs:232).
//   (b) captures the ANSWER (remote) SDP text on both peers for the
//       zero-127/8 + zero-100.64/10 hygiene assertion (report-side grep).
//   (c) first-frame ms for B is measured from A's PTT start (relay latency).
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
    w.__remoteSdp = [] as string[];
    const W = window.RTCPeerConnection;
    function PC(...args: any[]) {
      const pc: any = new (W as any)(...args);
      w.__pcs.push(pc);
      pc.addEventListener('icecandidate', (e: any) => {
        const c = e.candidate?.candidate || '';
        if (c) w.__ice.push({ type: (c.match(/typ (\w+)/) || [])[1] || '?', raw: c.slice(0, 90) });
      });
      // v2d hygiene capture: record the applied remote (answer) SDP
      const srd = pc.setRemoteDescription.bind(pc);
      pc.setRemoteDescription = (d: any) => {
        if (d && typeof d.sdp === 'string') w.__remoteSdp.push(d.sdp);
        return srd(d);
      };
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

// byte poller WITH tail accessor: keeps a timestamped bytesReceived timeline
async function startBytePoller(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__bytesTimeline = [] as { t: number; bytes: number }[];
    if (w.__poll) clearInterval(w.__poll);
    w.__poll = setInterval(() => {
      Promise.all(
        (w.__pcs || []).map((p: any) =>
          p.getStats().then((stats: any) => {
            let b = 0;
            stats.forEach((s: any) => {
              if (s.type === 'inbound-rtp' && s.kind === 'audio') b += s.bytesReceived || 0;
            });
            w.__bytesTimeline.push({ t: Date.now(), samples: w.__bytesTimeline.length, bytes: b });
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

async function remoteSdp(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__remoteSdp || []);
}

async function join(tag: string, ctx: BrowserContext) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(`${BASE}/bridge?t=${encodeURIComponent(TOKEN)}&b=${encodeURIComponent(BRIDGE)}`);
  // v2b2 flake fix: the QR-param pickup fills the field via useEffect — wait
  // for the value, don't race hydration (v2b2 died at 422ms on a cold page).
  await expect(page.getByTestId('bridge-token')).toHaveValue(/^bfnd-/, { timeout: 15_000 });
  const t = await page.getByTestId('bridge-token').inputValue();
  const t0 = Date.now();
  await page.getByTestId('bridge-connect').click();
  try {
    await expect(page.getByTestId('bridge-state')).toContainText('connected', { timeout: 30_000 });
  } catch (e: any) {
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
        remoteSdp: (window as any).__remoteSdp,
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
    voice = `NO-REPLY: ${String(e).split('\n')[0]}`;
  }
  const firstMs = await firstByteMs(page, t0);
  console.log(`[${tag}] PTT voice="${voice.slice(0, 70)}" first_remote_audio_ms=${firstMs ?? 'NEVER'}`);
  return { voice, firstMs, t0 };
}

// B polls bytesReceived across the whole window; assert GROWTH across 2 polls.
async function bByteEvidence(page: Page): Promise<{ timeline: { t: number; bytes: number }[]; grew: boolean }> {
  const tl: { t: number; bytes: number }[] = await page.evaluate(() => (window as any).__bytesTimeline || []);
  let grew = false;
  for (let i = 2; i < tl.length; i++) {
    if (tl[i].bytes > tl[i - 2].bytes && tl[i].bytes > 0) { grew = true; break; }
  }
  return { timeline: tl, grew };
}

test('v2d: B receives A frames over public path; zero 127/8 + zero CGNAT in answer SDP', async ({ browser }) => {
  test.setTimeout(420_000);
  const ctxA = await browser.newContext({ viewport: { width: 360, height: 180 } });
  const ctxB = await browser.newContext({ viewport: { width: 360, height: 180 } });
  await instrument(ctxA, 'A');
  await instrument(ctxB, 'B');
  let pageA: Page | null = null;
  let pageB: Page | null = null;

  const result: any = { tokenTail: TOKEN.slice(-6), base: BASE, bridge: BRIDGE, room: 'v2d-shared-room' };

  try {
    // ---- B first: joins, starts byte poller that runs across everything ----
    const { page: B, joinMs: joinB } = await join('B', ctxB);
    pageB = B;
    result.joinB_ms = joinB;
    await startBytePoller(B);

    // ---- A: joins, full turn (text through brain), then PTT voice turn ----
    const { page: A, joinMs: joinA } = await join('A', ctxA);
    pageA = A;
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

    // grace window: B keeps polling while A's reply audio may still stream
    await B.waitForTimeout(4000);

    // ---- B evidence: bytesReceived growth ACROSS 2 polls (dispatch (c)) ----
    const bBytes = await bByteEvidence(B);
    result.B = {
      bytesGrew: bBytes.grew,
      timelineHead: bBytes.timeline.slice(0, 3),
      timelineTail: bBytes.timeline.slice(-3),
      maxBytes: bBytes.timeline.length ? bBytes.timeline[bBytes.timeline.length - 1].bytes : null,
    };
    const turnB = await pttTurn('B', B);
    result.B.voice = turnB.voice;
    result.B.firstRemoteAudioMs = turnB.firstMs;
    await stopBytePoller(B);

    // ---- hygiene + pair evidence ----
    result.pairA = await selectedPair(A);
    result.pairB = await selectedPair(B);
    result.iceA = await A.evaluate(() => (window as any).__ice);
    result.iceB = await B.evaluate(() => (window as any).__ice);
    result.remoteSdpA = await remoteSdp(A);
    result.remoteSdpB = await remoteSdp(B);
    await dumpStats(A, `${OUT}/stats-A.json`);
    await dumpStats(B, `${OUT}/stats-B.json`);
    await B.screenshot({ path: '/tmp/vps-audio/vps-audio-room.png' });

    // hygiene assert off the captured answer SDPs (also grepped report-side)
    const sdpBlob = (result.remoteSdpA || []).join('\n') + '\n' + (result.remoteSdpB || []).join('\n');
    result.sdpHygiene = {
      loopback127: (sdpBlob.match(/127\.\d+\.\d+\.\d+/g) || []).length,
      cgnat10064: (sdpBlob.match(/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+/g) || []).length,
    };
    result.verdict =
      bBytes.grew && turnA.firstMs !== null && turnB.firstMs !== null && result.sdpHygiene.loopback127 === 0 && result.sdpHygiene.cgnat10064 === 0
        ? 'GREEN'
        : 'RED';
    fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 1));
    console.log(`V2D ${result.verdict} bBytesGrew=${bBytes.grew} firstA=${turnA.firstMs} firstB=${turnB.firstMs} hyg=${JSON.stringify(result.sdpHygiene)} pairA=${JSON.stringify(result.pairA)} pairB=${JSON.stringify(result.pairB)}`);
  } catch (e: any) {
    const fail: any = { error: String(e.message).split('\n')[0], result };
    for (const [tag, pg] of [['A', pageA], ['B', pageB]] as any[]) {
      if (!pg) continue;
      try {
        fail[tag] = await pg.evaluate(() => ({
          ice: (window as any).__pcs.map((p: any) => p.iceConnectionState),
          conn: (window as any).__pcs.map((p: any) => p.connectionState),
          candidatesOffered: (window as any).__ice,
          remoteSdp: (window as any).__remoteSdp,
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

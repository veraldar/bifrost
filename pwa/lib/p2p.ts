/**
 * P2P transport client — the pinned direct channel to the box's bridge
 * (v0.9, FLAGGED: Part 15 §b keeps HTTP the app protocol; this transport is
 * reached from /p2p and never replaces the session UI's fetches).
 *
 * The phone dials the bridge DIRECTLY — its signaling URL came from the QR, so
 * no signaling server exists anywhere. Trust-on-first-scan: the bridge
 * answer's DTLS fingerprint must equal the one the QR pinned, or the
 * connection is refused before a byte of app data flows (injected candidates
 * or a swapped answer = mismatch; the browser's own DTLS then enforces the
 * fingerprint on the wire). No STUN/TURN servers: LAN host candidates only —
 * nothing discloses the box or the phone to a third party (Part 15 §a.5).
 */

export type Pin = { fp: string; bridge: string; box: string; deviceId: string; pairedAt: string };

const PIN_KEY = 'bifrost.pin';

export function loadPin(): Pin | null {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) || 'null');
  } catch {
    return null;
  }
}

export function savePin(p: Pin) {
  localStorage.setItem(PIN_KEY, JSON.stringify(p));
}

export const normFp = (s: string) =>
  s
    .toLowerCase()
    .replace(/^sha-256\s*/, '')
    .replace(/[^0-9a-f]/g, '');

export function sdpFingerprint(sdp: string): string {
  return sdp.match(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/)?.[1] || '';
}

export class PinMismatch extends Error {}

export type Notice = { op: string; [k: string]: unknown };
type Reply = { req: number; ok?: boolean; err?: string; [k: string]: unknown };

function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    const t = setTimeout(res, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        res();
      }
    });
  });
}

export class BridgeLink {
  private seq = 0;
  private waiting = new Map<number, (m: Reply) => void>();
  onNotice: (n: Notice) => void = () => {};
  onClose: (why: string) => void = () => {};

  private constructor(
    private pc: RTCPeerConnection,
    private dc: RTCDataChannel,
  ) {}

  static async open(pin: Pin, token: string): Promise<BridgeLink> {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('app');
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 3000);
    const r = await fetch(`${pin.bridge.replace(/\/$/, '')}/offer`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pc.localDescription),
    });
    if (!r.ok) {
      pc.close();
      throw new Error(`bridge refused (${r.status}): ${(await r.text()).slice(0, 160)}`);
    }
    const answer = (await r.json()) as RTCSessionDescriptionInit;
    const got = sdpFingerprint(answer.sdp || '');
    if (!got || normFp(got) !== normFp(pin.fp)) {
      pc.close();
      throw new PinMismatch(`bridge fingerprint ${got || 'missing'} ≠ pinned ${pin.fp}`);
    }
    await pc.setRemoteDescription(answer);
    await new Promise<void>((res, rej) => {
      if (dc.readyState === 'open') return res();
      const t = setTimeout(() => rej(new Error('data channel never opened')), 15_000);
      dc.onopen = () => {
        clearTimeout(t);
        res();
      };
    });
    const link = new BridgeLink(pc, dc);
    dc.onmessage = (e) => link.receive(String(e.data));
    dc.onclose = () => link.onClose('channel closed');
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) link.onClose(`peer ${pc.connectionState}`);
    };
    return link;
  }

  private receive(txt: string) {
    let m: Reply & Notice;
    try {
      m = JSON.parse(txt);
    } catch {
      return;
    }
    const waiter = typeof m.req === 'number' ? this.waiting.get(m.req) : undefined;
    if (waiter && !m.op) {
      this.waiting.delete(m.req);
      waiter(m);
      return;
    }
    this.onNotice(m);
  }

  call(op: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<Reply> {
    const req = ++this.seq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.waiting.delete(req);
        rej(new Error(`${op}: no reply`));
      }, timeoutMs);
      this.waiting.set(req, (m) => {
        clearTimeout(t);
        if (m.ok === false) rej(new Error(m.err || `${op} failed`));
        else res(m);
      });
      this.dc.send(JSON.stringify({ op, req, ...args }));
    });
  }

  get open() {
    return this.dc.readyState === 'open';
  }

  close() {
    this.pc.close();
  }
}

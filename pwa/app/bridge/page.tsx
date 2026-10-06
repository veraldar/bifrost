'use client';

/**
 * /bridge — the v0.9 no-tailscale client (validation surface).
 *
 * One RTCPeerConnection to the bifrost-net bridge carries EVERYTHING:
 *   - `app` data channel: session list/create, prompt, transcript, run.done
 *   - audio track up: mic → bridge → STT → opencode
 *   - audio track down: TTS reply → <audio> playback
 * Token from /pair gates the signaling offer.
 *
 * This page proves the seam end-to-end; graduating it INTO the main session
 * page (replacing the livekit path by default) is the v1.0 merge.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

type Msg = { role?: string; parts?: unknown };
type ChatLine = { who: 'you' | 'bifrost' | 'sys'; text: string };

export default function BridgePage() {
  const [token, setToken] = useState('');
  const [bridgeUrl, setBridgeUrl] = useState('');
  const [state, setState] = useState('idle');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [sid, setSid] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiceState, setVoiceState] = useState('');
  const [lastLatency, setLastLatency] = useState<number | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const sidRef = useRef('');
  const reqCounter = useRef(1);
  const pendingReplies = useRef<Map<number, (v: string) => void>>(new Map());
  const commitAt = useRef(0);
  const dcRttRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const say = useCallback((who: ChatLine['who'], text: string) => {
    setLines((l) => [...l.slice(-200), { who, text }]);
  }, []);

  const send = useCallback(
    (payload: Record<string, unknown>): Promise<string> => {
      return new Promise((resolve, reject) => {
        const dc = dcRef.current;
        if (!dc || dc.readyState !== 'open') return reject(new Error('data channel not open'));
        const req = reqCounter.current++;
        pendingReplies.current.set(req, resolve);
        dc.send(JSON.stringify({ ...payload, req }));
        setTimeout(() => {
          if (pendingReplies.current.delete(req)) reject(new Error(`timeout on ${payload.op}`));
        }, 15000);
      });
    },
    []
  );

  const refreshTranscript = useCallback(
    async (id: string) => {
      try {
        const r = await send({ op: 'transcript', id });
        const v = JSON.parse(r);
        const msgs = (v.messages || []) as Msg[];
        const chat: ChatLine[] = [];
        for (const m of msgs) {
          const role = (m as { info?: { role?: string } })?.info?.role;
          const who = role === 'assistant' ? 'bifrost' : role === 'user' ? 'you' : 'sys';
          const parts = Array.isArray(m.parts) ? m.parts : [];
          const text = parts
            .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: string }).text) : ''))
            .join('');
          if (text) chat.push({ who, text });
        }
        setLines(chat);
      } catch {
        /* transcript refresh is best-effort */
      }
    },
    [send]
  );

  const connect = useCallback(async () => {
    setState('connecting');
    try {
      const t = token.trim();
      if (t.length < 16) throw new Error('paste the device token from /pair');
      localStorage.setItem('bifrost_device', t);
      const url = bridgeUrl.trim() || `http://${location.hostname}:18080`;
      localStorage.setItem('bifrost_bridge', url);

      const pc = new RTCPeerConnection({ iceServers: [] });
      pcRef.current = pc;

      // audio up: mic (Playwright drives it with a real-speech WAV fixture)
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);

      // app data channel
      const dc = pc.createDataChannel('app');
      dcRef.current = dc;
      dc.onopen = async () => {
        setState('channel-open');
        try {
          await send({ op: 'hello' });
          // transport latency: 5 channel round-trips (P2P leg quality)
          const pings: number[] = [];
          for (let i = 0; i < 5; i++) {
            const t0 = performance.now();
            await send({ op: 'ping', t: i });
            pings.push(Math.round(performance.now() - t0));
          }
          const avg = Math.round(pings.reduce((a, b) => a + b, 0) / pings.length);
          dcRttRef.current = avg;
          setState('connected');
          say('sys', `bridge connected · channel RTT ~${avg}ms`);
        } catch (e) {
          setState(`hello failed: ${e}`);
        }
      };
      dc.onmessage = (ev) => {
        try {
          const v = JSON.parse(ev.data);
          const pending = v.req ? pendingReplies.current.get(Number(v.req)) : undefined;
          if (pending) {
            pendingReplies.current.delete(Number(v.req));
            pending(ev.data);
            return;
          }
          if (v.op === 'run.done' && sidRef.current) {
            say('sys', 'bifrost finished thinking');
            void refreshTranscript(sidRef.current);
          }
          if (v.op === 'voice.stt') {
            setVoiceState(`heard: "${v.text}"`);
            say('you', v.text);
          }
          if (v.op === 'voice.reply') {
            const ms = commitAt.current ? Date.now() - commitAt.current : null;
            if (ms) setLastLatency(ms);
            setVoiceState(`reply audio: ${v.frames} frames (${ms ?? '?'}ms commit→reply)`);
            say('bifrost', v.text);
          }
          if (v.op === 'voice.error') setVoiceState(`voice error: ${v.err}`);
        } catch {
          /* ignore malformed */
        }
      };
      pc.ontrack = (ev) => {
        if (audioRef.current) {
          audioRef.current.srcObject = ev.streams[0];
          void audioRef.current.play().catch(() => {});
        }
      };

      // Chrome is trickle-only: candidates NEVER appear in offer.sdp — they
      // fire via onicecandidate. Collect them and POST them alongside.
      const trickle: string[] = [];
      pc.onicecandidate = (ev) => {
        if (ev.candidate) trickle.push(ev.candidate.candidate);
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const done = () => resolve();
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') done();
        });
        setTimeout(done, 2500); // cap: loopback gathers in ms
      });
      const r = await fetch(`${url}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({ type: offer.type, sdp: offer.sdp, candidates: trickle }),
      });
      if (r.status === 401) throw new Error('bridge rejected the device token (pair first)');
      if (!r.ok) throw new Error(`bridge signaling failed: ${r.status}`);
      const answer = await r.json();
      await pc.setRemoteDescription(answer);
      setState('signaled — ICE running');
    } catch (e) {
      setState(`error: ${e}`);
    }
  }, [token, bridgeUrl, send, say, refreshTranscript]);

  const ensureSession = useCallback(async () => {
    if (sidRef.current) return sidRef.current;
    const r = await send({ op: 'session.create', name: `bridge-${new Date().toISOString().slice(11, 19)}` });
    const v = JSON.parse(r);
    sidRef.current = v.id;
    setSid(v.id);
    return v.id as string;
  }, [send]);

  const sendPrompt = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const id = await ensureSession();
      say('you', text);
      setDraft('');
      await send({ op: 'prompt', id, text });
      say('sys', 'bifrost is thinking…');
    } catch (e) {
      say('sys', `error: ${e}`);
    } finally {
      setBusy(false);
    }
  }, [draft, busy, ensureSession, say, send]);

  const commitVoice = useCallback(() => {
    const id = sidRef.current;
    if (!id) {
      setVoiceState('open a session first (send a text message)');
      return;
    }
    commitAt.current = Date.now();
    setVoiceState('transcribing…');
    void send({ op: 'voice.commit', id, ms: 0 }).catch((e) => setVoiceState(`error: ${e}`));
  }, [send]);

  useEffect(() => {
    setToken(localStorage.getItem('bifrost_device') || '');
    setBridgeUrl(localStorage.getItem('bifrost_bridge') || '');
  }, []);

  return (
    <main className="mx-auto flex h-dvh max-w-2xl flex-col px-4 py-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">bridge</h1>
        <span className="text-xs opacity-70" data-testid="bridge-state">
          {state}
          {sid ? ` · ${sid}` : ''}
        </span>
      </header>

      {state !== 'connected' ? (
        <div className="mt-6 flex flex-col gap-3">
          <p className="text-sm opacity-70">
            Paste the device token from <a className="underline" href="/pair">/pair</a> and
            connect — everything (app + voice) rides one WebRTC session to the bridge.
          </p>
          <input
            data-testid="bridge-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="bfnd-… device token"
            className="rounded border bg-transparent px-3 py-2 text-sm"
          />
          <input
            value={bridgeUrl}
            onChange={(e) => setBridgeUrl(e.target.value)}
            placeholder="bridge url (default http://host:18080)"
            className="rounded border bg-transparent px-3 py-2 text-sm"
          />
          <button
            data-testid="bridge-connect"
            onClick={connect}
            className="rounded border px-3 py-2 text-sm hover:bg-white/5"
          >
            Connect to bridge
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3 flex-1 space-y-2 overflow-y-auto text-sm" data-testid="bridge-log">
            {lines.map((l, i) => (
              <p key={i} className={l.who === 'bifrost' ? 'font-medium' : 'opacity-80'}>
                <span className="mr-2 text-xs uppercase opacity-50">{l.who}</span>
                {l.text}
              </p>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              data-testid="bridge-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendPrompt()}
              placeholder="message over the data channel…"
              className="flex-1 rounded border bg-transparent px-3 py-2 text-sm"
            />
            <button
              data-testid="bridge-send"
              onClick={sendPrompt}
              disabled={busy}
              className="rounded border px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-50"
            >
              send
            </button>
            <button
              data-testid="bridge-ptt"
              onMouseDown={() => setVoiceState('listening…')}
              onMouseUp={commitVoice}
              onTouchStart={() => setVoiceState('listening…')}
              onTouchEnd={commitVoice}
              className="rounded border px-3 py-2 text-sm hover:bg-white/5"
            >
              🎙
            </button>
          </div>
          <p className="mt-1 text-xs opacity-60" data-testid="bridge-voice">
            {voiceState}
            {dcRttRef.current !== null ? ` · channel RTT ${dcRttRef.current}ms` : ''}
            {lastLatency !== null ? ` · voice round-trip ${lastLatency}ms` : ''}
          </p>
        </>
      )}
      <audio ref={audioRef} autoPlay className="hidden" />
    </main>
  );
}

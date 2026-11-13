import type { Page } from '@playwright/test';

/** hsim init script (human-sim-plan ③): runs in every page before app code.
 *  mic-in   getUserMedia → a WebAudio MediaStreamDestination; window.__hsim.say(url) pushes a WAV
 *           into it (a turn), window.__hsim.echo(true) also routes the page's own speaker into it.
 *  speaker  every <audio>.play() is tapped → __hsim.played[{t0,t1,text,src}] (text from the /api/tts spy).
 *  marks    deck/cycle/phase changes + sse + warn, timestamped (Date.now()).
 *  mic.on   the mic track's `enabled` (livekit mute() flips it) — "mic re-armed" for the asserts. */
export async function installHsim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Mark = { k: string; v: string; t: number };
    type Played = { t0: number; t1: number; text: string; src: string };
    const w = window as unknown as { __hsim: Record<string, unknown> };
    const marks: Mark[] = [];
    const played: Played[] = [];
    const put = (k: string, v: string) => marks.push({ k, v, t: Date.now() });
    let ctx: AudioContext | null = null;
    let dest: MediaStreamAudioDestinationNode | null = null;
    const tracks: MediaStreamTrack[] = [];
    let echo = false;
    const levels: { t: number; rms: number }[] = [];
    const ac = () => {
      if (!ctx) {
        ctx = new AudioContext();
        dest = ctx.createMediaStreamDestination();
        // level meter ON the mic stream itself: what the mic track really carries (echo-route proof)
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(dest.stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let e = 0;
          for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
          const rms = Math.sqrt(e / buf.length);
          if (rms > 0.003) levels.push({ t: Date.now(), rms });
        }, 40);
      }
      void ctx.resume();
      return ctx;
    };
    const md = navigator.mediaDevices;
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (c && c.audio) {
        ac();
        const t = dest!.stream.getAudioTracks()[0].clone();
        tracks.push(t);
        const s = new MediaStream([t]);
        // a silent carrier keeps the track "live" between turns
        return s;
      }
      return gum(c);
    };
    const feed = async (url: string) => {
      const c = ac();
      const buf = await c.decodeAudioData(await (await fetch(url)).arrayBuffer());
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(dest!);
      src.start();
      put('mic.say', url.split('/').pop() || url);
      return buf.duration;
    };
    let lastTts = '';
    const f = window.fetch;
    window.fetch = function (...a: Parameters<typeof fetch>) {
      const u = String(a[0] instanceof Request ? a[0].url : a[0]);
      if (u.includes('/api/tts')) {
        try {
          const b = a[1]?.body;
          lastTts = typeof b === 'string' ? ((JSON.parse(b) as { text?: string }).text ?? '') : '';
        } catch {
          lastTts = '';
        }
        put('tts.fetch', 'start ' + lastTts.slice(0, 60));
        return f.apply(window, a).then(
          (r) => (put('tts.fetch', 'resp ' + r.status), r),
          (e) => (put('tts.fetch', 'ERR ' + e), Promise.reject(e))
        );
      }
      return f.apply(window, a);
    } as typeof fetch;
    const tapped = new WeakSet<HTMLMediaElement>();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement, ...a: Parameters<typeof HTMLMediaElement.prototype.play>) {
      const el = this;
      const rec: Played = { t0: Date.now(), t1: 0, text: lastTts, src: String(el.currentSrc || el.src).slice(0, 80) };
      put('audio.play', 'called');
      el.addEventListener('ended', () => (rec.t1 = Date.now()), { once: true });
      el.addEventListener('pause', () => (rec.t1 = rec.t1 || Date.now()), { once: true });
      if (!tapped.has(el) && echo) {
        try {
          const c = ac();
          const s = c.createMediaElementSource(el);
          s.connect(c.destination);
          s.connect(dest!);
          tapped.add(el);
        } catch {
          /* already tapped */
        }
      }
      const p = play.apply(this, a);
      p.then(
        () => (put('audio.play', 'resolved'), played.push(rec)),
        (e) => put('audio.play', 'REJECTED ' + String(e))
      );
      return p;
    };
    const wr = console.warn;
    console.warn = (...a: unknown[]) => (put('warn', a.join(' ').slice(0, 160)), wr(...a));
    const es = window.EventSource;
    window.EventSource = class extends es {
      constructor(u: string | URL, o?: EventSourceInit) {
        super(u, o);
        this.addEventListener('message', (e) => put('sse', String((e as MessageEvent).data).slice(0, 40)));
      }
    } as typeof EventSource;
    const last: Record<string, string> = {};
    const tick = () => {
      const fp = document.querySelector('[data-testid="free-phase"]');
      const v1 = fp?.getAttribute('data-cycle') ?? 'off';
      const v2 = document.querySelector('.oz-deck') ? (document.querySelector('.oz-deck.paused') ? 'paused' : 'playing') : '-';
      const v3 = tracks.length ? (tracks.some((t) => t.enabled) ? 'on' : 'muted') : 'none';
      for (const [k, v] of [['cycle', v1], ['deck', v2], ['mic', v3]] as const)
        if (last[k] !== v) {
          last[k] = v;
          put(k, v);
        }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__hsim = {
      marks,
      played,
      say: feed,
      echo: (on: boolean) => (echo = on),
      levels,
      level: (t0: number, t1: number) => levels.filter((l) => l.t >= t0 && l.t <= t1).reduce((m, l) => Math.max(m, l.rms), 0),
      tracks,
      get mic() {
        return { on: tracks.some((t) => t.enabled), n: tracks.length };
      },
    };
  });
}

export type HMark = { k: string; v: string; t: number };
export const marks = (page: Page): Promise<HMark[]> =>
  page.evaluate(() => (window as unknown as { __hsim: { marks: HMark[] } }).__hsim.marks.slice());

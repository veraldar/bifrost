/** The roots' voice line (MAINFRAME-C, 10-26): hold the roots on the front
 *  page → hands-free with MAIN starts on the spot, without leaving the list.
 *  The same machinery as MAIN's composer mic, end to end: the same token
 *  route (room = session slug, identity user_<room>), the same voice agent
 *  and its RPCs (ptt_begin / commit_turn / ptt_abort out, free_state /
 *  end_free back), the same primitives (lib/voice-room), the same TTS deck
 *  (lib/speech), the same heard + read watermarks — a reply spoken here is
 *  never played again when MAIN opens, and MAIN opens hands-free if the
 *  roots left it on (oz-mode, MAIN's own mode rule).
 *
 *  The cycle, as in MAIN's hands-free: hold = mic live, release = the turn
 *  is committed and the mic pauses (working) → the run settles → the reply
 *  is spoken (speaking) → the mic comes back (listening) → "over" sends the
 *  next turn, "over and out" ends it, the stop key ends it. A drop (slid
 *  off) sends nothing and undoes the hold.
 *
 *  Loaded lazily by components/roots.tsx: livekit-client never rides the
 *  front page's first load. One instance per page, disposed on leave. */
import { Room, RoomEvent, Track, createAudioAnalyser } from 'livekit-client';
import type { Msg } from '@/components/session-message';
import { diagEvent } from '@/lib/diag';
import { markHeard } from '@/lib/heard';
import { markRead } from '@/lib/read';
import { getSpeech, startSpeech, stopSpeech, subscribeSpeech } from '@/lib/speech';
import { isOnboardPrompt, stripMarkers } from '@/lib/tree-first';
import { ECHO_TAIL_MS, agentInRoom, releaseMicDevice, withTimeout } from '@/lib/voice-room';

export type RootsPhase =
  | 'off' // no voice here: the roots show MAIN's row
  | 'opening' // held: room + mic coming up — words are not captured yet
  | 'talk' // held and capturing: let go = sent
  | 'listening' // hands-free: the mic is hot, "over" sends (or hold again)
  | 'working' // sent: the brain is on it, the mic is paused
  | 'speaking'; // the reply, out loud, here — the mic is paused

export type RootsSnap = {
  phase: RootsPhase;
  /** hands-free is on (the mic comes back after each reply) */
  free: boolean;
  /** the room / session the roots talk to (MAIN, or voice-test) */
  slug: string;
  /** the reply's words while they are spoken */
  reply: string;
  /** one truthful line, for a moment ("nothing heard …") */
  note: string;
};

export const ROOTS_OFF: RootsSnap = { phase: 'off', free: false, slug: '', reply: '', note: '' };

const BARS = 9;
const POLL_MS = 2_000;
/** a commit with nothing in it lands no turn — the mic comes back */
const NOTHING_MS = 12_000;
/** the stall watchdog aborts a hung run at 10 min — past it, stop waiting */
const STALL_MS = 10 * 60_000;

type Seen = { total: number; lastTime: number };
type Cycle = {
  base: Seen;
  speak: boolean; // false: "over and out" / stopped — the answer lands as text
  idle: boolean; // session.idle seen (run-events)
  landed: boolean; // the turn is in the transcript
  stable: string; // run state seen on the last poll (two equal = settled)
  replyTime: number; // the reply being spoken (heard/read watermark)
  speaking: boolean;
};

function setMode(m: 'text' | 'free') {
  try {
    localStorage.setItem('oz-mode', m);
  } catch {
    /* private mode — the mode just doesn't carry */
  }
}

/** the first sentence-ish of a reply, for the roots' one line */
function firstWords(text: string): string {
  return stripMarkers(text).replace(/\s+/g, ' ').trim().slice(0, 160);
}

export class RootsLine {
  private snap: RootsSnap = ROOTS_OFF;
  private subs = new Set<() => void>();
  private room: Room | null = null;
  private roomP: Promise<Room> | null = null;
  private slug = '';
  private pin = '';
  private holding = false; // the finger (or Space) is down
  private pressAt = 0;
  private live = false; // the mic track is publishing, unmuted
  private startedFree = false; // this hold turned hands-free on — a drop undoes it
  private es: EventSource | null = null;
  private seen: Seen = { total: 0, lastTime: 0 };
  private seenP: Promise<unknown> = Promise.resolve();
  private cycle: Cycle | null = null;
  private pollT: ReturnType<typeof setTimeout> | null = null;
  private nothingT: ReturnType<typeof setTimeout> | null = null;
  private stallT: ReturnType<typeof setTimeout> | null = null;
  private echoT: ReturnType<typeof setTimeout> | null = null;
  private noteT: ReturnType<typeof setTimeout> | null = null;
  private reconnectT: ReturnType<typeof setTimeout> | null = null;
  private reconnectFails = 0;
  private bars: HTMLElement | null = null;
  private raf = 0;
  private levelsOff: (() => void) | null = null;
  private offSpeech: () => void;
  private disposed = false;
  get gone() {
    return this.disposed;
  }
  /** the run is over (spoken or not): the page refreshes MAIN's row */
  onSettled: () => void = () => {};

  constructor() {
    this.offSpeech = subscribeSpeech(() => this.onSpeech());
  }

  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => void this.subs.delete(f);
  };
  get = () => this.snap;
  private set(p: Partial<RootsSnap>) {
    this.snap = { ...this.snap, ...p };
    this.subs.forEach((f) => f());
  }
  private say(note: string, ms = 5_000) {
    if (this.noteT) clearTimeout(this.noteT);
    this.set({ note });
    this.noteT = setTimeout(() => this.set({ note: '' }), ms);
  }

  /** the bars element (9 <i>) the live levels are written into — direct
   *  style writes, never a React render per frame on the front page */
  setBars(el: HTMLElement | null) {
    this.bars = el;
  }

  // ── the hold ─────────────────────────────────────────────────────────────
  /** the hold armed (past the tap window): hands-free starts on the spot */
  async holdStart(slug: string, pin: string, pressAt: number) {
    if (this.disposed) return;
    if (this.slug && this.slug !== slug) this.teardown(); // voice tests switched meanwhile
    this.slug = slug;
    if (pin) this.pin = pin;
    this.holding = true;
    this.pressAt = pressAt;
    this.endCycle(); // a hold while MAIN works or speaks starts a new turn
    this.startedFree = !this.snap.free;
    if (this.startedFree) {
      setMode('free');
      diagEvent('roots', `hold → hands-free with ${slug}`);
    }
    this.set({ free: true, slug, note: '', reply: '', phase: this.live ? 'talk' : 'opening' });
    // barge-in: a hold while the reply speaks stops it (MAIN's pttDown)
    if (getSpeech().phase !== 'idle') {
      stopSpeech();
      diagEvent('roots', 'barge-in: the hold stopped the reply');
    }
    this.openEvents();
    this.seenP = this.refresh(); // the transcript as it is before this turn
    try {
      const room = await this.ensureRoom();
      if (!this.snap.free || this.disposed) return; // stopped while connecting
      // a hold is ONE turn: the agent keeps turns manual (fire & forget)
      if (this.holding) void this.rpc(room, 'ptt_begin');
      if (!this.live) await this.micOn(room);
      else this.set({ phase: this.holding ? 'talk' : 'listening' });
    } catch (e) {
      diagEvent('voice-fail', `roots: ${e instanceof Error ? e.message : e}`);
      this.exitFree('connect failed');
      this.set({ phase: 'off' });
      this.say(`voice connect failed — ${e instanceof Error ? e.message : e}`, 8_000);
    }
  }

  /** let go: sent — or, slid off, nothing (the hold never happened) */
  async holdEnd(drop: boolean) {
    if (!this.holding) return;
    this.holding = false;
    const room = this.room;
    if (drop) {
      diagEvent('roots', 'drop — nothing sent');
      // the screen answers at once: as if never held (the hold that turned
      // hands-free on undoes it), or back to listening inside hands-free
      const undo = this.startedFree;
      if (undo) {
        this.set({ phase: 'off' });
        setMode('text');
      } else this.set({ phase: 'listening' });
      // MAIN's discard order: the mic pauses, the agent drops the buffered
      // turn, and only then may the device go dark — never race the abort
      await this.micPause();
      if (room) await this.rpc(room, 'ptt_abort');
      if (undo) this.stop('drop');
      else if (this.snap.free && room) void this.micOn(room);
      return;
    }
    if (!this.live || !room) {
      // let go before the mic was live: nothing was captured. Hands-free
      // stays on — the mic comes up, and "over" sends what is said then
      diagEvent('roots', 'released before the mic was live — hands-free stays on');
      this.say('nothing captured yet — talk now, say “over” to send');
      return;
    }
    // the mic pauses BEFORE the commit (the agent flushes its own silence)
    this.startCycle(true);
    await this.micPause();
    const agent = await agentInRoom(room, 4_000);
    if (!agent) {
      diagEvent('voice-fail', 'roots commit: no voice agent in the room after 4s');
      this.say('voice agent missing from the room — is lk-agent running?', 8_000);
      this.giveBack();
      return;
    }
    try {
      const res = await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: 'commit_turn',
        payload: '{}',
        responseTimeout: 14_000, // agent worst case: 1.5s flush + 8s transcript wait
      });
      if (res && res !== 'ok') throw new Error(res);
      diagEvent('roots', 'turn committed');
    } catch (e) {
      // a stale room (the agent's session closed): drop it, reconnect fresh
      diagEvent('voice-fail', `roots commit: ${e instanceof Error ? e.message : e}`);
      this.say('voice session stale — reconnecting…');
      this.dropRoom(room);
      this.endCycle();
      if (this.snap.free) {
        this.set({ phase: 'opening' });
        this.reconnect();
      }
      return;
    }
    this.armNothing();
  }

  /** the stop key: hands-free ends here — the buffer dies, the reply stops,
   *  the mic device goes dark. A run already going finishes as text. */
  stop(why = 'stop') {
    const room = this.room;
    this.holding = false;
    const wasFree = this.snap.free;
    this.exitFree(why, false); // the screen and the mode: at once
    if (room && wasFree) {
      // the device: paused now, dark once the agent dropped the buffer
      // (anything said and not yet sent dies here — MAIN's exit)
      void (async () => {
        await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
        if (why !== 'drop') await this.rpc(room, 'ptt_abort');
        if (!this.snap.free && this.room === room) releaseMicDevice(room);
      })();
    }
    const speaking = !!this.cycle?.speaking;
    if (getSpeech().phase !== 'idle') stopSpeech();
    if (this.cycle && !speaking && this.snap.phase === 'working') {
      this.cycle.speak = false; // keep watching quietly: the list learns when it lands
      return;
    }
    this.endCycle();
    this.set({ phase: 'off', reply: '' });
    this.onSettled();
  }

  /** leaving the page: the room and the voice go with it (MAIN's rule) —
   *  the mode stays as it was, so MAIN opens hands-free if it was on */
  dispose() {
    if (this.disposed) return;
    if (this.holding && this.room) void this.rpc(this.room, 'ptt_abort');
    this.disposed = true;
    this.endCycle();
    for (const t of [this.noteT, this.reconnectT]) if (t) clearTimeout(t);
    this.stopLevels();
    this.es?.close();
    this.es = null;
    this.offSpeech();
    if (getSpeech().phase !== 'idle') stopSpeech();
    this.room?.disconnect();
    this.room = null;
    this.roomP = null;
    this.subs.clear();
  }

  // ── the room ─────────────────────────────────────────────────────────────
  private ensureRoom(): Promise<Room> {
    if (this.room) return Promise.resolve(this.room);
    if (!this.roomP) {
      this.roomP = this.connect().catch((e) => {
        this.roomP = null;
        throw e;
      });
    }
    return this.roomP;
  }

  private async connect(): Promise<Room> {
    const slug = this.slug;
    const r = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: slug }),
    });
    if (!r.ok) throw new Error(`token ${r.status}`);
    const d = await r.json();
    const room = new Room({ adaptiveStream: false });
    room.on(RoomEvent.Disconnected, () => {
      diagEvent('roots', 'room disconnected');
      if (this.room === room) {
        this.room = null;
        this.roomP = null;
        this.live = false;
        this.stopLevels();
      }
      // self-heal only while hands-free still wants the mic
      if (!this.disposed && this.snap.free) this.reconnect();
    });
    room.on(RoomEvent.MediaDevicesError, (e: Error) => diagEvent('voice-fail', `roots: ${e}`));
    await withTimeout(room.connect(d.serverUrl, d.participantToken), 12_000, 'signal');
    // the agent's keyword turn cycle: "over" → processing (mic pauses, the
    // reply is spoken here), "over and out" → hands-free ends (text reply)
    room.localParticipant.registerRpcMethod('free_state', async (data) => {
      let state = '';
      try {
        state = JSON.parse(data.payload).state;
      } catch {
        return 'bad-payload';
      }
      if (state === 'processing' && this.snap.free) {
        diagEvent('roots', '“over” — the turn is sent');
        this.holding = false;
        this.startCycle(true);
        await this.micPause();
        this.armNothing();
      }
      return 'ok';
    });
    room.localParticipant.registerRpcMethod('end_free', async () => {
      diagEvent('roots', 'end_free rpc — “over and out”');
      this.exitFree('over and out');
      this.startCycle(false); // its answer lands as text, never spoken
      this.armNothing();
      return 'ok';
    });
    if (this.disposed || slug !== this.slug) {
      void room.disconnect();
      throw new Error('roots: left before the room was ready');
    }
    this.room = room;
    this.reconnectFails = 0;
    diagEvent(
      'roots',
      `room ${slug} ready ${Math.round(performance.now() - this.pressAt)}ms after press`
    );
    return room;
  }

  private dropRoom(room: Room) {
    if (this.room !== room) return; // a newer room is not ours to drop
    this.room = null;
    this.roomP = null;
    this.live = false;
    this.stopLevels();
    void room.disconnect();
  }

  /** one attempt at a time, backing off (MAIN's reconnectVoice) */
  private reconnect() {
    if (this.disposed || this.reconnectT) return;
    if (this.reconnectFails >= 4) {
      this.exitFree('voice dropped');
      this.endCycle();
      this.set({ phase: 'off' });
      this.say('the voice dropped — hold the roots to talk again', 8_000);
      return;
    }
    this.reconnectT = setTimeout(
      () => {
        this.reconnectT = null;
        if (this.disposed || !this.snap.free) return;
        this.ensureRoom()
          .then((room) => {
            if (this.snap.phase === 'opening' || this.snap.phase === 'listening')
              return this.micOn(room);
            return undefined;
          })
          .catch(() => {
            this.reconnectFails += 1;
            this.reconnect();
          });
      },
      Math.min(4_000, 250 * 2 ** this.reconnectFails)
    );
  }

  private async rpc(room: Room, method: string) {
    const agent = Array.from(room.remoteParticipants.values())[0];
    if (!agent) return;
    await room.localParticipant
      .performRpc({
        destinationIdentity: agent.identity,
        method,
        payload: '{}',
        responseTimeout: 4_000,
      })
      .catch(() => {});
  }

  // ── the mic ──────────────────────────────────────────────────────────────
  private async micOn(room: Room) {
    // the device and the agent come up together: on a cold room (the first
    // hold of a visit) the agent is being dispatched right now. Until both
    // are there the bars stay flat and the roots say the mic is opening —
    // never "talk" into an empty room (the onset lesson, UX-BATCH #3)
    let agent: unknown = true;
    try {
      [, agent] = await Promise.all([
        room.localParticipant.setMicrophoneEnabled(true),
        room.remoteParticipants.size ? true : agentInRoom(room, 8_000),
      ]);
    } catch (e) {
      diagEvent('voice-fail', `roots mic: ${e instanceof Error ? e.message : e}`);
      this.exitFree('mic failed');
      this.endCycle();
      this.set({ phase: 'off' });
      this.say(`the mic did not open — ${e instanceof Error ? e.message : e}`, 8_000);
      return;
    }
    if (this.disposed || !this.snap.free || this.room !== room) {
      releaseMicDevice(room); // stopped while the device came up
      return;
    }
    if (this.cycle) {
      // a cycle began meanwhile ("over" from a warm buffer): the mic pauses
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      return;
    }
    if (!agent) {
      diagEvent('voice-fail', 'roots: no voice agent in the room after 8s');
      this.exitFree('no agent');
      this.set({ phase: 'off' });
      this.say('voice agent missing from the room — is lk-agent running?', 8_000);
      return;
    }
    this.live = true;
    this.startLevels(room);
    this.set({ phase: this.holding ? 'talk' : 'listening' });
    const ms = Math.round(performance.now() - this.pressAt);
    diagEvent(
      'roots',
      `mic live ${ms}ms after press${this.holding ? '' : ' (released — hands-free)'}`
    );
    if (this.holding) {
      try {
        navigator.vibrate?.(12); // the walkie's chirp: capturing now
      } catch {
        /* no haptics: the bars carry it */
      }
    }
  }

  private async micPause() {
    this.live = false;
    this.stopLevels();
    await this.room?.localParticipant.setMicrophoneEnabled(false).catch(() => {});
  }

  /** hands-free off: the mode goes back to the keyboard, the capture device
   *  goes dark; the room stays warm while the page lives (the next hold is
   *  quick, MAIN's keyboard-mode rule) */
  private exitFree(why: string, release = true) {
    if (!this.snap.free) return;
    this.set({ free: false });
    setMode('text');
    this.live = false;
    this.stopLevels();
    if (release && this.room) releaseMicDevice(this.room);
    diagEvent('roots', `hands-free off (${why})`);
  }

  private startLevels(room: Room) {
    this.stopLevels();
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!pub?.audioTrack) return;
    const { analyser, cleanup } = createAudioAnalyser(pub.audioTrack);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const nyquist = analyser.context.sampleRate / 2;
    const binOf = (hz: number) =>
      Math.min(bins.length - 1, Math.round((hz / nyquist) * bins.length));
    const lo = binOf(100);
    const width = Math.max(1, Math.floor((Math.max(lo + BARS, binOf(2000)) - lo + 1) / BARS));
    const tick = () => {
      analyser.getByteFrequencyData(bins);
      const kids = this.bars?.children;
      if (kids) {
        for (let i = 0; i < BARS && i < kids.length; i++) {
          let sum = 0;
          let n = 0;
          for (let b = lo + i * width; b < Math.min(lo + (i + 1) * width, bins.length); b++, n++)
            sum += bins[b];
          const v = Math.min(1, ((n ? sum / n : 0) / 255) * 2.2);
          (kids[i] as HTMLElement).style.transform = `scaleY(${(0.18 + v * 0.82).toFixed(3)})`;
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.levelsOff = () => void cleanup().catch(() => {});
  }

  private stopLevels() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.levelsOff?.();
    this.levelsOff = null;
    const kids = this.bars?.children;
    if (kids) for (const k of Array.from(kids)) (k as HTMLElement).style.transform = '';
  }

  // ── the cycle: sent → the run settles → spoken → the mic comes back ──────
  private startCycle(speak: boolean) {
    this.endCycle();
    const cycle: Cycle = {
      base: { ...this.seen },
      speak,
      idle: false,
      landed: false,
      stable: '',
      replyTime: 0,
      speaking: false,
    };
    this.cycle = cycle;
    // the transcript as it stood before the turn — a refresh still in flight
    // from the hold decides it (the turn needs a flush + STT, it lands later)
    void this.seenP.then(() => {
      if (this.cycle === cycle && !cycle.landed) cycle.base = { ...this.seen };
    });
    this.set({ phase: 'working', reply: '' });
    this.pollT = setTimeout(() => void this.poll(), POLL_MS);
    this.stallT = setTimeout(() => {
      if (this.cycle !== cycle) return;
      diagEvent('roots', 'still working after 10 min — the mic comes back');
      this.say('still working — the answer will be in main', 8_000);
      this.giveBack();
    }, STALL_MS);
  }

  private endCycle() {
    for (const t of [this.pollT, this.nothingT, this.stallT, this.echoT]) if (t) clearTimeout(t);
    this.pollT = this.nothingT = this.stallT = this.echoT = null;
    this.cycle = null;
  }

  /** a commit that lands no turn (nothing said, or only silence) */
  private armNothing() {
    const cycle = this.cycle;
    if (this.nothingT) clearTimeout(this.nothingT);
    this.nothingT = setTimeout(async () => {
      if (this.cycle !== cycle || !cycle || cycle.landed) return;
      await this.poll(true);
      if (this.cycle !== cycle || cycle.landed) return;
      diagEvent('roots', 'nothing was heard — the mic comes back');
      this.say(cycle.speak ? 'nothing heard — talk, then let go (or say “over”)' : 'nothing heard');
      if (cycle.speak) this.giveBack();
      else {
        this.endCycle();
        this.set({ phase: 'off' });
      }
    }, NOTHING_MS);
  }

  /** GET the transcript tail; `seen` follows it */
  private async refresh(): Promise<{ msgs: Msg[]; live: boolean; st: string } | null> {
    const slug = this.slug;
    try {
      const r = await fetch(`/api/session/${encodeURIComponent(slug)}/messages?limit=30`, {
        cache: 'no-store',
        headers: this.pin ? { 'X-Session-Pin': this.pin } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok || slug !== this.slug) return null;
      if (!this.pin) this.pin = r.headers.get('X-Session-Id') || '';
      const msgs = (await r.json()) as Msg[];
      const total = Number(r.headers.get('X-Total-Count') || msgs.length);
      this.seen = { total, lastTime: msgs.length ? msgs[msgs.length - 1].time : 0 };
      return {
        msgs,
        live: r.headers.get('X-Run-Live') === '1',
        st: r.headers.get('X-Run-State') || '',
      };
    } catch {
      return null; // transient — the next poll tries again
    }
  }

  /** one read at a time: the run-events nudge and the timer both ask —
   *  two judges in flight spoke the reply twice (the second start cut the
   *  first, the cut read as "the reply ended" and the mic came back early) */
  private polling: Promise<void> | null = null;
  private pollAgain = false;
  private poll(once = false): Promise<void> {
    if (this.polling) {
      this.pollAgain = true;
      return this.polling;
    }
    this.polling = this.pollOnce(once).finally(() => {
      this.polling = null;
      if (this.pollAgain) {
        this.pollAgain = false;
        void this.poll();
      }
    });
    return this.polling;
  }
  private async pollOnce(once: boolean) {
    const cycle = this.cycle;
    if (!cycle) return;
    if (this.pollT) clearTimeout(this.pollT);
    this.pollT = null;
    const res = await this.refresh();
    if (this.cycle !== cycle) return;
    if (res) this.judge(cycle, res);
    if (!once && this.cycle === cycle && !cycle.replyTime) {
      this.pollT = setTimeout(() => void this.poll(), POLL_MS);
    }
  }

  /** the turn landed? the run over? the reply → spoken (or, quietly, done) */
  private judge(cycle: Cycle, { msgs, live, st }: { msgs: Msg[]; live: boolean; st: string }) {
    // by ORDER, server times only: the newest user message past the base
    let ui = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'user' && m.time > cycle.base.lastTime && !isOnboardPrompt(m.text)) {
        ui = i;
        break;
      }
    }
    if (ui < 0) return;
    if (!cycle.landed) {
      cycle.landed = true;
      diagEvent('roots', 'the turn landed in the transcript');
    }
    let a: Msg | undefined;
    for (let i = msgs.length - 1; i > ui; i--) {
      if (msgs[i].role === 'assistant' && msgs[i].text.trim()) {
        a = msgs[i];
        break;
      }
    }
    // settled: session.idle seen — or no live run and the same completed
    // assistant state on two polls in a row (MAIN's busy-clear rule)
    const completed = st.endsWith('|assistant') && st.split('|')[1] !== '0';
    const settled = cycle.idle || (!live && completed && st === cycle.stable);
    cycle.stable = st;
    if (!a || a.done === false || !settled) return;
    this.reply(cycle, a);
  }

  private reply(cycle: Cycle, a: Msg) {
    if (cycle.replyTime) return; // this cycle's reply is already decided
    cycle.replyTime = a.time;
    if (this.pollT) clearTimeout(this.pollT);
    if (this.nothingT) clearTimeout(this.nothingT);
    if (this.stallT) clearTimeout(this.stallT);
    this.pollT = this.nothingT = this.stallT = null;
    if (!cycle.speak || !this.snap.free) {
      // "over and out" or stopped: the answer is text in MAIN — unread
      diagEvent('roots', 'the run settled — answer left as text');
      this.endCycle();
      this.set({ phase: 'off' });
      this.onSettled();
      return;
    }
    diagEvent('roots', 'the run settled — speaking the reply here');
    cycle.speaking = true;
    this.set({ phase: 'speaking', reply: firstWords(a.text) });
    startSpeech(a.text, this.slug);
    if (getSpeech().phase === 'idle') this.afterSpeech(); // nothing speakable in it
  }

  private onSpeech() {
    const cycle = this.cycle;
    if (!cycle?.speaking) return;
    const phase = getSpeech().phase;
    if (phase === 'playing') {
      // real audio went out: heard (MAIN won't play it again) and read
      markHeard(this.slug, cycle.replyTime);
      markRead(this.slug, cycle.replyTime);
    } else if (phase === 'idle') {
      this.afterSpeech();
    }
  }

  /** the reply is over (ended, stopped, or never started): the mic comes
   *  back after the echo tail — never into the phone's own last words */
  private afterSpeech() {
    const cycle = this.cycle;
    if (!cycle) return;
    cycle.speaking = false;
    this.set({ reply: '' });
    this.onSettled();
    if (!this.snap.free) {
      this.endCycle();
      this.set({ phase: 'off' });
      return;
    }
    if (this.echoT) clearTimeout(this.echoT);
    this.echoT = setTimeout(() => this.giveBack(), ECHO_TAIL_MS);
  }

  /** back to listening (hands-free) — or off, if it ended meanwhile */
  private giveBack() {
    this.endCycle();
    if (!this.snap.free) {
      this.set({ phase: 'off' });
      return;
    }
    this.set({ phase: 'listening' });
    const room = this.room;
    if (room) void this.micOn(room).catch(() => this.reconnect());
    else this.reconnect();
  }

  // ── run-events: session.idle = the whole run is over ────────────────────
  private openEvents() {
    if (this.es || typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/run-events?slug=${encodeURIComponent(this.slug)}`);
    es.onmessage = (ev) => {
      const cycle = this.cycle;
      if (!cycle) return;
      if (ev.data.startsWith('error|')) {
        const msg = ev.data.slice('error|'.length);
        diagEvent('roots', `run-error: ${msg}`);
        this.say(`no reply — ${msg}`, 8_000);
        this.giveBack();
        this.onSettled();
        return;
      }
      if (ev.data === 'idle') {
        cycle.idle = true;
        void this.poll();
      } else if (ev.data === 'step') {
        void this.poll();
      }
    };
    this.es = es;
  }

  /** voice tests switched while the roots were warm: a new room, a new line */
  private teardown() {
    this.endCycle();
    this.exitFree('room changed');
    this.stopLevels();
    this.es?.close();
    this.es = null;
    this.room?.disconnect();
    this.room = null;
    this.roomP = null;
    this.pin = '';
    this.seen = { total: 0, lastTime: 0 };
    this.set({ phase: 'off' });
  }
}

let one: RootsLine | null = null;
/** the page's one line (re-created after a dispose) */
export function rootsLine(): RootsLine {
  if (!one || one.gone) one = new RootsLine();
  return one;
}

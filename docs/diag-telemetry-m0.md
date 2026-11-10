# M0 inventory — what diag already captures (req 10-02 telemetry)

One read pass over the diag seam: `pwa/lib/diag.ts`, `pwa/app/session/[slug]/page.tsx`,
`pwa/lib/speech.ts`, `pwa/lib/oc-forward.ts`, `pwa/lib/oc-watchdog.ts`,
`pwa/app/api/diag/route.ts`, `pwa/app/api/session/[id]/messages/route.ts`,
`agent/agent.py` (payload seam only). Line refs are to HEAD 1367c18.

Pipeline (exists, works): `diagEvent(kind,msg)` → ring buffer → batch POST /api/diag
→ append to `pwa/.diag/diag-YYYY-MM-DD.log` (+ journalctl summary). Events are
free-form `{t, kind, msg}`; taps auto-captured via a global click listener.

## Capability 1 — MODE AWARENESS

**Already captured**
- Client mode state exists: `mode: 'text' | 'free'` + `modeRef`, persisted to
  localStorage `oz-mode` (page.tsx:170, 231, 796, 1016).
- Mode-adjacent prose events (kind `voice`): "keyboard mode — mic device
  released" (:1033), "released (over and out)" (:1002), "hands-free restored
  after refresh" (:806), "end_free rpc — exiting hands-free" (:933).
- Voice room state: mic permission, "connecting signal…", "ready" (:891-955).

**Gaps (provable)**
- No structured mode on ANY event — mode is only inferable from prose of a
  few `voice` lines; `ptt`/`busy`/`net`/`tap`/`run` events carry nothing.
- Hands-free ENTRY logs nothing (switchMode('free') is silent until
  "connecting signal…").
- Message payload carries NO mode: `sendTextAsync` POSTs `{text, images,
  files, async}` (:1601); the messages route `buildParts` has no mode field;
  the voice agent posts bare `{parts:[{type:'text',text}]}` (agent.py:137).
  Nothing tells the agent/LLM "user is hands-free → reply short and spoken".

## Capability 2 — CONNECTION LIFECYCLE

**Already captured**
- LiveKit room events: SignalConnected / Connected / Disconnected /
  MediaDevicesError → `voice` / `voice-fail` events (:906-925).
- Self-heal `reconnectVoice()` with dedupe timer + exponential backoff
  (:866-885), triggered from the Disconnected handler (:908-924).
- Token POST timing via the fetch wrapper (`net` / `net-fail` events).

**Gaps (provable)**
- Disconnect logs NO reason — LiveKit's `DisconnectionReason` is unused.
- No durations anywhere: signal→ready connect time, disconnect→reconnected
  gap, reconnect backoff sequence — all only derivable by diffing prose
  timestamps.
- `reconnectVoice` attempts/failures/backoff are completely unlogged
  (`reconnectFailsRef` is invisible in diag).
- No SignalReconnecting / SignalReconnected subscription — in-room signal
  and data drops are invisible while the room stays nominally connected.
- Token refresh does not exist on this base (one token per connect); expiry
  surfaces as an opaque disconnect.

## Capability 3 — INTERACTION OUTCOME

**Already captured**
- Generic `tap` event for every button/link click with label (diag.ts:170-183)
  — the PRESS is logged.
- Some outcome events: pre-room PTT lifts (`ptt` :1083, :1161), missing
  voice agent (`voice-fail` :1188, :1653), commit RPC non-ok → stale-room
  path (:1203), working-dot lifecycle `busy` arm/tick/clear/wedge/abort/
  run-error (:301, :669, :691, :730, :754, :1510, :1377), HTTP-level send
  failures via the fetch wrapper (`net-fail`).

**Gaps (provable)**
- No expected-effect → observed-effect pairing per interaction: "PTT pressed
  → was the mic actually enabled?" (`setMicrophoneEnabled` awaited at :1100,
  success unlogged), "send → did the message land?" (POST 200 ≠ landed; echo
  reconciliation :580-584 unlogged), "working dot cleared — by what?".
- Mic-gesture paths fire no click event and log nothing on this base:
  `micTap` (tap-to-toggle), PTT hold-arm, slide-to-cancel, free-strip
  tap-to-send, deck stop. Pointer-event paths bypass the click `tap`
  capture; `toggleHandsFree` is silent.
- Silent no-effect paths: `ptt_begin` / `ptt_abort` RPCs `.catch(() => {})`
  (:1098, :1137) — failures invisible, so no-effect events are not countable.

## Environment note (merge risk, not a blocker)

The main working tree (`~/Work/bifrost`) holds UNCOMMITTED page.tsx changes
(tap-threshold reinterpretation with `pttDownAtRef`, plus earlier PHONE-DIAG
work that already added micTap/pttDown gesture diag logging per docs/claims.md
entries open-restore-r2 / tap-threshold). This branch is from committed main
(1367c18) and does NOT contain them. The gesture-logging gap above is
partially fixed by that uncommitted work; this branch's implementation must
merge cleanly with it — outcome logging is designed to attach at the same
call sites without rewriting them.

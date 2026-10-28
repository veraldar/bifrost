# ROOT CONTRACT — yggdrasil (:4100)

**Law:** the root stays as simple as opencode — maybe less. MAIN coordinates sessions, subsessions, rooms, topics; the root only serves sessions.

## 1. Inventory — verdicts

| Feature (where it lives today) | Verdict | Why / how |
|---|---|---|
| Session CRUD + JSON store (`main.rs`) | IN-ROOT | opencode parity; the core |
| Run loop: per-session serialization, step cap, abort | IN-ROOT | parity |
| Tools: bash/read/write/http (`tools.rs`) | IN-ROOT | parity |
| Model/agent routing, catalog, per-session switches | IN-ROOT | routing is the root's job |
| Event bus `GET /event` + triad state working/blocked/idle | IN-ROOT | a projection, not behavior — it IS the seam's vocabulary |
| Compaction: token prune + summarize at cap (`rollup.rs`) | IN-ROOT, minimal | opencode has compaction; load-bearing (148k marathons). Smarter context = extension |
| Voice sanitizer `YGG_VOICE`, `YGG_VOICE_MAX_WORDS` (lane2-merge / release-v09 builds) | EXTENSION | TTS text-shaping is a voice concern; the agent already owns STT/TTS. Root returns plain text |
| MAIN reserved session (`pwa/lib/tree-first.ts`, delete guard) | EXTENSION — already external | root has zero MAIN code; keep it so, contract-test it |
| Letters + `/api/push` (S4: `scripts/agi-run.sh`, `pwa/lib/push.ts`) | EXTENSION — already external | letters subscribe to terminal events; root only emits |
| Room slug / topic mapping (`pwa/lib/oc.ts`: title-with-dashes) | EXTENSION — client-side | rooms = session titles; root never learns the word |
| Dispatcher / queued turns / relay (planned gate item 8, "the relay in v0.7.x") | EXTENSION — do NOT land in root | an external driver subscribes `/event`, POSTs `/message`. Root keeps run serialization only |

## 2. The contract — the root is X and nothing else

1. **Sessions:** create/list/get/patch/delete; JSON on disk; boot closes interrupted runs.
2. **Runs:** one run per session; queued posts wait their turn; step cap; abort; tools run in the project dir.
3. **Routing:** per-session model + agent (v2 switches), catalog, openai/anthropic dialect relay to `YGG_UPSTREAM`.
4. **Context:** token estimate, prune, summarize at `YGG_ROLLUP_TOKENS`. Nothing richer.
5. **Transport:** REST + SSE bus; every state change emits exactly one event.
6. **Seam:** everything drivable and observable via API.

The root has no MAIN, no voice, no letters, no push, no schedules, no timers, no flows, no topics, no rooms, no webhooks. It never calls out; it never waits on anything but its own run. Review bar: a root PR containing any of those words is rejected.

## 3. Extension seam

Dependency direction is one-way: **extension → root**.

- **Events:** `GET /event` (SSE): `session.created/deleted`, `session.state` (working | blocked+reason | idle), text deltas, tool start/result. Terminal events (`blocked`, `idle`) are what schedulers subscribe to.
- **Drive:** `POST /session {title?, parentID?}` (spawn is just CRUD), `POST /session/:id/message` (self-queuing), `POST /session/:id/abort`.
- **Pull:** `GET /session`, `/session/:id`, `/session/:id/message`, `/session/:id/todo`, `/session/status|state`; letters/artifacts are files on disk.
- **Hooks:** none in the root. A "hook" is an external process subscribed to `/event`. The root never blocks on, retries, or notifies an extension.

This surface suffices for: **scheduling** (driver posts turns when events warrant), **loops** (driver re-POSTs on terminal events), **flows** (driver chains sessions via `parentID`), **letters** (driver writes envelope + push), **richer context** (extension injects parts before `POST /message`).

## 4. Migration map (ordered; v0.7 reliable-voice gate untouched)

| # | Move | Size | Why safe |
|---|---|---|---|
| 1 | Pull `YGG_VOICE*` out of the root's env contract; port the speech sanitizer to the agent; `verify.sh` voice block moves with it | S | live voice flows agent→opencode; the sanitizer is post-processing — identical text either way |
| 2 | Write these verdicts into drift-guard as named rows (letters/push, MAIN, rooms stay external) — never silent loss | S | docs only |
| 3 | Gate item 8's dispatcher lands as external `ygg-driver`, not root code | M | prevents the next overreach before it compiles |
| 4 | Contract tests: root boots with no MAIN/voice/letter/push strings; each state change emits exactly one event | M | additive CI |
| 5 | Richer context (wells/grove/federation) as extension: context injected before `POST /message` | L | root API unchanged |

Steps 1–2 relocate or document; 3–5 are additive-external. Nothing above can break the v0.7 gate.

# ONBOARD-UX — settings UX-truth fixes (sandbox)

Session ONBOARD-UX · 2026-10-20 · tree `~/Work/bifrost-sandbox` (lab/sandbox), served by `bifrost-sandbox` :8090 → :8443.
The live stack (`~/Work/bifrost`, lk-pwa, lk-agent) was not touched. Commits: `35f0334` · `ac182f0` · `9cb2820`.
Served build `yYlFA3QPEpNDPUL3SNkpy`: the id served matches `.next/BUILD_ID`, and the settings chunk returns 200.

![MAIN settings after the fixes](/api/artifact/onboard-ux-main-settings.png)

## 1. "Renaming main silently does nothing" — fixed (`35f0334`)
- **Real cause** (checked in the served chunk; the brief's diagnosis was off): MAIN's name field is `readOnly`, so the PATCH never fires. A tap got no reaction, and the only explanation was a dim caption. The 409 is reached only when another session is renamed *to* "main". That went to the ErrorBox, which offered "fix this" (it spawns a fix session) for a correct refusal, and the refused name stayed in the field.
- **Fix:** the guard stays (the field stays locked, and the proxy still returns 409). Tapping MAIN's field now shows "MAIN can't be renamed — it keeps its name, the tree door finds it by it" inline (`role=alert`, red, house `.note` style). Any PATCH 4xx (title/model/agent) now shows inline under the block the user touched, with the server's reason. A refused rename puts the field back to the real name. 5xx and network errors stay in the ErrorBox.
- **Proxy:** brain refusals keep their status and reason. Before: a bare 500 `Error: opencode 400 on …`. Now: `{agent:'nope'}` → `400 unknown agent nope`.

## 2. Settings showed no model — fixed (`ac182f0`)
- **Cause:** MAIN has `model: null`. The voice worker's one-time `VOICE_MODEL` seed got 400 from yggdrasil until the 10-19 11:47 drop-in (lk-agent-ygg journal). The page read null as "nothing chosen". The `/model` route does exist (a bogus id gets a handler 404 and GET gets 405); the null came from the failed seed, not a missing route.
- **What the sandbox runs:** yggdrasil `/config/providers` → `default: {yggdrasil: glm-5.3-flash}` (the env sets `YGG_UPSTREAM_MODEL=glm-5.3-flash`, and the worker has `VOICE_MODEL=yggdrasil/glm-5.3-flash`). **The brain reports it, so nothing is faked and no TODO-VERIFY is needed.**
- **Fix:** new `lib/brain-default.ts` reads the default from the brain. opencode: `GET /config` `.model`. yggdrasil has no `/config`, so it falls back to the single-entry `/config/providers` default. Anything else → shown as "brain default · not reported". `/api/session/[id]` gains `defaultModel`. The MODEL tile reads `yggdrasil/glm-5.3-flash · default` with the note "the brain's default, set on the box — pick one to pin this session". The picker tags that row, and THINK shows the running model's levels.

## 3. `/api/models` and empty states — fixed (`9cb2820`)
- **Bug:** load marked itself done even on failure, so the self-heal retry never ran. A failed session fetch showed **"tap to choose"**, failed models showed **"no models"**, and failed agents showed invented `build`/`plan` chips.
- **Fix:** each resource now shows one of loading / failed (with the reason, retrying every 2 s) / empty. The picker tells apart "loading models…", "couldn't load models — why", "no model matches “q”", and "the brain offers no models". Agent chips are never invented. With no agent pinned, the note says "none pinned — the brain's default agent runs".
- **Fix:** `/api/models` now takes think levels from the derived `<id>-think-<level>` models, which is the rule the PATCH accepts. It used to read opencode's native `variants`. On live opencode data, 8 of 15 models list native levels with no derived model behind them, so keeping your level when switching models failed with "unknown model" (e.g. `glm-5.3-think-high`). The sandbox `/api/models` returns 200 and is unchanged (`glm-5.3-flash`, no levels).

## Evidence
- New brain-agnostic spec `e2e/settings-truth.spec.ts` (never writes MAIN): **7/7 pass**. Each new test failed on the build before its fix.
- Sandbox general suite (`PW_BASE_URL=:8090 PW_JITLESS=1`, jitless shell, lk-yggdrasil cgroup): **33 passed / 9 failed / 2 skipped / 4 did not run.** base:73 passes on rerun (known flake). **0 regressions.** The remaining 8 failures:
  - context:8 and wedge:16/58 fail inside the jitless runner itself (`fetch → WebAssembly is not defined`).
  - subs:24/71 fail because yggdrasil has no sub-sessions.
  - settings:32 fails in `beforeAll`: it PATCHes `zai-coding-plan` models that yggdrasil doesn't have. That file's other 4 tests didn't run.
  - door-repro:79 and stt-phone:34 are other sessions' untracked specs with their own fresh-device configs. The general config's returning-device storage skips the door, so they can't pass under it.
  - context:8, settings:32, subs:24/71 and wedge:16/58 are also on the 3703171 baseline list. base:73 is the known flake.

## Open / follow-ups
- **TODO-VERIFY:** `e2e/settings.spec.ts:89` now opens the picker by its tile (the "tap to choose" label is gone). That test only runs against opencode, and nothing here can serve this build against opencode (no JIT in this cgroup). It needs the next promote gate.
- **Door honesty on opencode:** `/api/onboard` shows the *first* `/config/providers` default. On live, that would read `…glm-5.3-flash-think-max` while the real default (`/config.model`) is `…-think-high`. The sandbox is correct (one entry). `lib/brain-default.ts` is ready for the door to adopt; I left the door alone (ONBOARD-BUILD's area).
- yggdrasil records a model switch but sends every turn to its one upstream model. That's harmless with a one-model catalog, but settings would lie once the catalog grows.
- The brief's "no LLM selected" text doesn't exist in source. What the user saw was "tap to choose" plus "pick a model to see its thinking levels", both gone now.

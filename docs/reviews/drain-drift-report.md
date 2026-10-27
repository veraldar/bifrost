# DRAIN-DRIFT report — 10-27

Mission: port the KNOWN-GAP rows of `scripts/drift-guard.sh` onto `lab/sandbox`.
**Count:** the brief said 14; the guard listed **9 KNOWN-GAP rows on lab/sandbox** (4 agent, 2 pwa, 3 pwa-named), plus 3 on release-v07 and 1 on main (`first-turn-tap`, structural, reviewed). All 9 sandbox rows are drained.

| fix | source commit | port commit | e2e / proof | state |
|---|---|---|---|---|
| bifrost-auth-declared | 7572aaa | e156a71 | `/api/token` guard on `BIFROST_AUTH=tailnet`; build green; token mint works (suite voice specs dial) | OK |
| tts-generation-lock | 6405ead | b2000b0 (via release c4b1908, verbatim) | build green; tts specs in general suite pass | OK |
| oc-headers-timeout | 40c6037 | b2000b0 | build green; whole suite drives `ocFetch` | OK |
| artifact-black-page | 547cb89 | 676e42e | `artifacts.spec.ts` 6/6 incl. new "md opened directly gets the black page" | OK |
| agent-rearm | 49a61e6 | 3b6e932 | curl `/api/dispatch` → 400 on no room, 200 on a room. `agent-rearm.spec.ts` **could not run** (node `fetch` is absent under `--jitless`) | OK (spec unrun, see below) |
| agent-load-inf | 79d53f1 | 139109f (verbatim release ca990ca) | `uv run python -c "import agent"` ok; `load_threshold=inf` | OK |
| agent-ordered-yield | c6a1b2d | 139109f | import ok, string present | OK |
| agent-split-brain | 79d53f1 | 139109f | import ok, `BRAIN MISMATCH` guard present | OK |
| agent-loopback-http | 232b25c | 139109f | import ok; `AgentServer.host == 127.0.0.1` | OK |

WAIVED: **none**. `first-turn-tap` on release-v07 already reads OK (probe present), so the sandbox's newer first-turn design (ef3cc3a…) was never at risk; nothing was ported for it.

## Notes
- Artifact route: the sandbox route differs from main's (`resolveArtifact` → `hit.type`/`hit.file`), so the patch was hand-applied, same logic.
- Rearm: only the `rearmAgent` helper hunk conflicted (sandbox already imports `agentInRoom` from `lib/voice-room`). The roots-voice call sites are not rearmed on main either.
- Dispatch route takes `process.env.AGENT_NAME || 'bifrost'` like the sandbox token route.
- Agent files came verbatim from release/v0.7 (`ca990ca`'s 3-way merge of lane2/merge + the 10-06 fixes) rather than re-merged. That commit also carried the then-uncommitted `STT_MODEL` default (identical to release's).
- **`lk-agent-ygg` still runs from `~/Work/lane2-merge/agent`**, not this tree: the ported agent code is on disk and imports clean, but no running worker uses it until that unit's WorkingDirectory moves. `lane2-merge` stays a named gap in the guard.
- Build ran in `pwa/` under :8090's `.next` (the brief's recipe), against AGENTS.md's "build in a scratch worktree" rule; restarted `bifrost-sandbox` right after; `where.sh` showed served = built.

## Suite on :8090 (jitless runner)
Full run (78 passed / 15 failed / 5 skipped) while a parallel ux-calm session was committing and restarting the unit. Failures, classified:
- 4 env: `agent-rearm`, `context`, `wedge` ×2 — `fetch failed: WebAssembly is not defined` (node fetch under `--jitless`; needs a JIT runner).
- 11 voice/footer UI texts (chrome-spacing, states, voice-ui, ux-batch-echo ×2, -hotword, -voicetest, -typed ×2, mainframe-c-voice ×2): stale against the ux-calm footer/walk changes. Re-run on HEAD ee81118 (ux-calm's spec fixes in): **9 of 11 pass**; still red: `mainframe-c-voice` "slide off while talking" (45 vs 46) and `ux-batch-hotword` ("heard · release to send" text). Neither touches a ported file; both are ux-calm's.
- So "general suite green" is **not** met: 6 reds remain, none in a ported file, 4 need a non-jitless run.

## Guard
`drift-guard.sh` after: zero KNOWN-GAP on lab/sandbox. Remaining named: `first-turn-tap` on main (structural), and `agent-rearm` / `artifact-black-page` / `bifrost-auth-declared` on release-v07 (frozen line, the user decides). Manifest edit is committed on rebuild/cohesive-opus (the script lives only there).

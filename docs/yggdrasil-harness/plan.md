# Yggdrasil harness rework — first gradual version

*Plan-builder run, 2026-10-07, for the [BUILD] yggdrasil-harness mission
(`ses_ee9323f2cffeoq8WW8O1V8yp5s`). This file is the plan and the specs only.
The [BUILD] session builds it slice by slice under `docs/lab-playbook.md`.
Companion files: `life-probe.py` (re-derives every store number below),
`verify.sh` (checks these deliverables), and the three UX propositions in
`artifacts/yggdrasil-ux-{near,mid,far}.html`.*

## North star

1. **The harness is the identity.** The model can be swapped at any time. The tree (yggdrasil) holds the sessions, the memory, the doctrine and the boundaries across every model and every session.
2. **A turn never dies silently.** Every run ends in one of three ways: a reply, a question parked where you can answer it by talking, or an error that says why.
3. **The tree is the door.** One gesture, holding the tree, opens the bridge. It works the same on veraldar.org and in the app. The first hold plants MAIN.
4. **Federation, not switching.** One list holds every session from every tree, each labelled with its tree. Trees talk to each other over the tailnet, and the phone keeps one URL.
5. **Freedom inside, walls outside.** You gate the intention and the edges. The harness guarantees continuity and visibility. The model owns everything in between.

---

## 0. What already exists (not re-planned)

| piece | state | proof |
|---|---|---|
| yggdrasil core API (sessions, SSE, abort, `/event`, persistence) | slices 1–2 green | `lab/yggdrasil/verify.sh` |
| PWA round-trip through `OPENCODE_URL` | slice 3 green: unmodified bifrost e2e 34 → 38 pass, 1 known real-model gap | `lab/yggdrasil/run-e2e.sh` in a private netns |
| install.sh + systemd user unit + PKGBUILD | slice 4 green, 8.1 MB static-ish binary | ASSESSMENT.md §4 |
| tool loop (bash/read/write/edit/glob/grep/webfetch/todowrite) | slice 6a green | verify.sh 6a block |
| context roll-up | slice 6b green (no ASSESSMENT section) | verify.sh 6b block |
| anthropic dialect (zai) | slice 7 green on the mock; one real turn proven | `verify-real-upstream.sh` |
| device-token seam ("S1") | in the PWA: `pwa/middleware.ts`, `pwa/lib/devices.ts`, `/pair`, behind `BIFROST_AUTH=devices` | STABLE.md, claims.md |
| self-tools prior art | `git stash@{0}` "ygg-rework WIP": selfstore.rs + session/self tools. Not in the tree. | SELF.md (the coordinator's draft map) |

Two facts from reading `src/` against the life (below). Both are defects of today's lab:

- **Tools are silent while they run.** `message.part.updated` fires only at the start and at the end (`main.rs` ~801/824). The PWA's unmodified watchdog (`pwa/lib/oc-watchdog.ts`, 10 min of quiet, keyed on the regex `"sessionID":"ses_…"`) would kill a long yggdrasil tool exactly the way it kills opencode's today.
- **The default bash timeout is 120 s** (`tools.rs`). In the life, **543 of 8,034 bash calls ran longer than that** (406 ran 2–10 min, 137 ran more than 10 min). Under the current default, the lab would turn 6.8 % of real work into errors.

---

## 1. The life — what the store says (Rule 10-02)

The store was snapshotted 2026-10-07 at about 19:00 (`python3 docs/yggdrasil-harness/life-probe.py`):
**223 sessions, 14,253 messages (1,929 user, 12,324 assistant), 52,090 parts, from 09-12 to 10-07.**
LIFE.md's 10-03 numbers (178 sessions, 9,892 messages) are stale: the life grew 44 % in four days.

The shape hasn't changed. Prompts are short (median 97 chars) and runs are long: the median turn takes 79 s, the p90 takes 776 s, and 287 turns ran over 10 min. The work is tool-dominated (bash is 65 % of tool parts), multi-day, and voice-heavy (at least 113 prompts read as dictation). Session titles carry caps tags (`[MAIN]`, `[LAB]`, `[WEBSITE]`, `[BRAND]`): the user organises sessions as lanes. The user writes to the harness in English (about 11 of 1,855 prompts are French) but is francophone, so the bridge's UI must treat both languages as first-class.

### The frictions, ranked by lived pain

| # | friction | measured | evidence (store ids) |
|---|---|---|---|
| **P1** | **Turns die mid-work** | 280 aborted turns (`MessageAbortedError`). **73 in-flight tool calls were killed between 571 and 637 s**, the PWA watchdog's 10-min band. **57 of those 73 touched paths outside the project or used ssh**, the `external_directory` permission class: the ask waited for a UI the phone doesn't have. The rest were silent long tools. Also 145 `STALL` lines in `pwa/.diag` over 12 days, 11 "watchdog revive" prompts in MAIN, and 28 turns that never completed. Still happening: 8 kills on 10-06. | KiCad extraction killed at 602–637 s at least 8 times in `ses_f0d1fd3c6ffeMteiRSFbRug4b7` (`msg_0f94b1ad2001BGLvDWxyHJEVr0`, `msg_0fd3520360010oe11HAUvAMnv0`, `msg_0fe7a9ac7001b3OMyV8Hrckr6H`, `msg_102bc7554001fT2Xs5JTdVtX0b`). A read of `~/.config/opencode/opencode.json` died at 597 s (`ses_f075d9f4dffeNzDUmV4EG5Oo86` / `msg_0f8a27bf10016wO5SKXUh3Fgu6`). A silent `cargo build` was killed at 620 s (`ses_f03a724f2ffeyFB06o8QEPjo5t` / `msg_10828f887001Ok9B0yS3HnU60g`). MAIN: "Your turn died again — mid-sentence" (`ses_f28e2fdf4ffeWng5LZZnYbCpnm` / `msg_10390e6460014ExfwuSWZ9GkgT`) and a revive (`msg_103b8c6fe001spaTg6EfMj6vQN`). **This mission's own launch call** died at 600 s (`ses_ee9323f2cffeoq8WW8O1V8yp5s` / `msg_116e780ea001yA7O9DKswFwoDK`). The fleet already found the root cause: `docs/claims.md:71` ("headless external_directory permission=ask → 10-min silent hang"). |
| **P2** | **Questions the phone can't answer** | The `question` tool asked 14 times. **2 were answered** (both from the terminal, in 35–47 s). 8 died and 4 still show `running` today. The asks were names and design picks: things the user answers in one spoken sentence. | The repo/project name was asked in 3 sessions and never answered (`ses_f2d393db7ffe0m4Muex44D00YE` / `msg_0d3d8e11d001GLvOZ3nPnPYlz2`, `ses_f2c097ac4ffe1OZ3uSK8vH7u2U` / `msg_0d3fa6a5d001137Qd20rkCwpac`, `ses_f2bc51158ffeo6EiP2Fpo07DjZ` / `msg_0d43d45a5001sL0iev0wkuZU8H`). The TTS-dock question waited 14,752 s, about 4.1 h (`ses_f28416789fferDyh4xJRpH1ym1` / `msg_0dd76233b0012AyJ4P651cFRyb`). The user asked for exactly this: "the session list should show the one where a question is awaiting an answer" (`ses_f2aef95d1ffeffwuETyzdsZiuO` / `msg_0d7269d5d001w9P5MqYhtq4co0`); "you didn't start the sub session, so I couldn't really answer" (`msg_1017c3a17001T0PZux5qekZd7q`). |
| **P3** | **"Is it done?" — no view of running work** | 27 bare status polls ("done?", "so?", "?"). 287 turns ran longer than 10 min, the p90 turn is 13 min, and short prompts trigger long runs. | "I see this session as working in the list but nothing in the session" (`ses_f114d2524ffe8K98DIWgNsUb9C` / `msg_0eecbd9350013HuLRJivJ1HcDo`). "It's past 200 seconds on one other session" (`ses_f2c158539ffeOpPEmhwbgemDkl` / `msg_0d3eab6c6001KNOM8Ro9JfCkLl`). "Need browser notification when thinking done" (`ses_f2d393db7ffe0m4Muex44D00YE` / `msg_0d3c23f09001iiEtKXtDiHto30`). "done?" (`ses_f279d75d2ffevOWH21sS9l9eJ0` / `msg_0d86f99b9001YWUYOfq2c85K3U`, `ses_f269378daffetlfC6m74JgkB1i` / `msg_0d9b1e952001snZwHgX9dHJgSR`). "hia he done?" (`ses_f2792deedffevKWJ1HExyUUOgG` / `msg_0fd7a3cd2001HaCnQmcz63HNGm`). |
| **P4** | **Agents run other sessions through the back door** | 540 bash `curl`s to the harness's own API from 42 sessions. 201 `claude -p` delegations (16 sessions). 269 `nohup`/`setsid` detaches (31 sessions). 212 `sleep ≥30` polling loops (23 sessions). 46 injected DRIVER/DIRECTIVE prompts. The need is real; it is met by hand, unmeasured. | "was the brand session notified?" (`msg_0fc5ae242001TMjHFEFozpRFT1`). "make all sessions … up to speed with the latest plan" (`msg_10373bb28001jHkD65LCBSw4Fa`). "seems session got lost so research in files session all" (`msg_107bf82d4001kwCmS87ZcI2CdZ`). "why the error on the other session" (`ses_f2640507affefLhOsxmGtHvVBl` / `msg_0d9e9f188001QU7icYUkgBorJd`). A raw curl orchestration (`ses_f543f0531ffeV5wlWczVPbaeN0` / `msg_0b3ddb8670019srAN9BeiSYVo9`). A `nohup` detach still killed at 622 s (`msg_0fd7733620016Bsb2R7vYk2ewY`). |
| **P5** | **Two trees, crossed by ssh** | **527 ssh calls to mac/studio/veraldar from 23 sessions.** Two bridges and two trees are already live (vision.md, FACTUAL BASELINE 10-03). | "why does it work here but not from the mac?" (`ses_f16aed3d8ffeIw6nCjtupU0Jpv` / `msg_0e982304c001jDWazs3JmrbTMm`). "the mac has its own pwa and livekit server correct?" (`msg_0e986059c001infOfjOjZlbLbz`). "works here should work on the mac now also?" (`msg_0ee18576a001bb3ITN7L30nrh3`). "the other bifrost instance … do you have access" (`msg_1029631e7001SYQH9YWw2pHDyS`). An example raw ssh (`msg_0b50ea675001yVBpRs5sBiSzXg`). |
| **P6** | **The marathon has no self outside its context** | MAIN has 1,876 messages over 12.5 days. **Its context is at 919,579 tokens against a configured 1,000,000, and no session has ever been compacted.** It grows about 35k tokens a day: the cliff is days away on the live brain. Memory lives only inside one context. | "How do you save my memories … starting different session" (`ses_f2776571efferwQYAggWnStCm1` / `msg_0d88abd53001wFT9LvW7yX3VX4`). "full prompt as it is passed in the session word by word" (`msg_10d6ec2060012vmrhluzJrtE20`). "we should only be gated … freedom of judgment" (`msg_101ba935a001ADJhmzpTnikQJ0`). |
| **P7** | **When the provider refuses, the turn dies** | 19 `APIError`s: 13 "Unknown Model" after a switch, 6 "credit balance too low". | `ses_f2792deedffevKWJ1HExyUUOgG` / `msg_0ecde9f6e001yqcKFZj0BrT7V5`; `ses_f269378daffetlfC6m74JgkB1i` / `msg_0ee202561001pWjcUjqOKd5ear`. |

**Never used, so not built:** sharing (0 sessions), revert (0), archive (0), the `plan` agent (38 of 12,324 steps, 0.3 %), `explore` (22), MCP (4 calls), opencode compaction (0).
Roles go away at no measurable cost, which confirms SELF.md promise 2. No slice below builds share, revert, or a plan/build split.

**What the user needed but never had to ask for** (the Rule 10-02 inference):

- **The user answers by talking, not by tapping "approve".** The 12 dead asks were naming and design questions, not permission prompts. So the next message to a waiting session *is* the answer.
- **The user wants edges, not path fences.** "Only contact me if you are stuck … or if you need human" (`ses_f543f0531ffeV5wlWczVPbaeN0` / `msg_0b01d750e001YpO4nTevwjxg75`). The real edges in the life are publishing (`msg_0fc4a078f001aYV2hwURViKuit`: "uploaded the wrong website, lost the work") and touching the live stack (`ses_f0d01bc41ffezK4nMORCB6ArR3` / `msg_0f3971d15001rIsdVTNAzBksrG`: `systemctl --user restart lk-pwa`; STABLE.md boundary rule 4). Reading `~/.config` is not an edge.
- **Voice and text are one session.** "I don't want a split between text/voice sessions" (`msg_0cfde4175001ADf6Lc8dPoRWmJ`).
- **The persona is a voice, chosen once.** "I prefer the woman voice … the man voice we can keep for other users" (`msg_1024abe9e001K72LG1EZyOxRtL`). "Like HER … you want to be a woman or a man voice" (`msg_10253aafa001H2MDDRm51vRi2L`).

---

## 2. The slices

**Shared law for every slice**

- **Ships alone.** `./verify.sh` stays green, and the PWA referee (`./run-e2e.sh --grep-invert "voice|hands-free|LiveKit"`) keeps ≥ 38 pass with only the known `context` real-model failure.
- **One commit per slice**, inside `lab/yggdrasil/`, with a req-linked message.
- **Frozen product.** No file under `pwa/`, `agent/` or `styles/` changes; the brand stays frozen.
- **Additive only.** Every new field and event adds to the opencode surface; nothing existing is renamed or removed.
- **The one seam holds.** Phone → its bridge's `/api/*` → its tree. Never direct.
- **Proxy GREEN is an interval** (Rule 10-05.1 / 10-08.3). Every hard verify runs 3 times in a row (`for i in 1 2 3; do … || exit 1; done`).
- **One receipt per slice**, in `lab/yggdrasil/receipts/<slice>.json`: timings, counts, pass/fail per assertion, env hash.

### H0 — M0: the liveness seam, proven small

- **Riskiest seam of the whole plan:** the plan claims the top frictions (P1, P2) can be fixed **inside the tree, with zero product code**. That holds only if the unmodified PWA watchdog counts tree-emitted heartbeat events as life. If it doesn't, P1 and P2 need a PWA change. That change waits for the UX pick, and the plan's order flips.
- **One file:** `lab/yggdrasil/m0/m0-liveness.sh`. Inline, it contains a ~40-line fake tree (python `http.server`) serving `/event` (SSE), `/session/status` and `/session/:id/abort`. The fake tree logs every abort to `abort.log` and reports `ses_m0silent` and `ses_m0beat` as busy. `ses_m0silent` emits nothing; `ses_m0beat` emits `{"type":"tool.heartbeat","properties":{"sessionID":"ses_m0beat",…}}` every 5 s.
  The script reuses `run-e2e.sh`'s netns pattern: `unshare -rn`, the live `.next` copied, never rebuilt. It starts the PWA with `OC_STALL_MS=15000 OPENCODE_URL=http://127.0.0.1:4096`, hits `GET /api/session` once (which runs `ensureWatchdog()`), and waits 45 s.
- **One command:** `cd ~/Work/bifrost/lab/yggdrasil && ./m0/m0-liveness.sh`
- **One verifiable output:** exit 0 and the line `M0 PASS silent=aborted@<15–45>s beat=alive@45s`, i.e. the silent session appears in `abort.log` and the heartbeat session does not. Any other result exits 1 with `M0 FAIL …`.
- **Prerequisites to install at M0, not to note:** `unshare -rn` must work, python3, and the live `.next` must exist. A missing one gets installed or escalated in the same turn (BLOCKED=VISIBLE).
- **Evidence:** `lab/yggdrasil/receipts/h0-m0.json` plus the PWA's own `.diag` watchdog lines, copied out of the netns scratch.
- **If M0 fails:** stop. Write `receipts/h0-m0.json` with the failure, and post the fork to the coordinator: (a) the fix needs a PWA change, so H1 and H2 wait for the UX pick, or (b) the tree raises its heartbeat to a full `message.part.updated` repeat, which the regex certainly matches. Option (b) is the fallback to try first. It is still zero product code.

### H1 — never-silent tools

- **Answers:** P1, the silent-long-tool class: 16 of the 73 watchdog-band kills, plus the 543 lived bash calls over 120 s that the lab would time out.
- **Goal:** a tool that is working is visibly alive, and is never killed for being quiet.
- **Mechanism:**
  - While any tool runs, emit `message.part.updated` every `YGG_HEARTBEAT_MS` (default 15000). The tool part stays `status:"running"`, and `state.metadata` carries `{elapsed_ms, bytes, tail}`, where `tail` is the last ≤ 400 chars of combined output.
  - bash reads stdout/stderr **incrementally** instead of using `wait_with_output`.
  - The default `YGG_BASH_TIMEOUT_MS` goes from 120 s to **30 min**. A per-call `timeout` is capped at 2 h. A timeout still SIGKILLs the process group (slice 6a law).
  - The heartbeat names a truthful state: the process group is alive, and its CPU time (from `/proc/<pid>/stat`) or its output is changing. A process alive but idle for 5 min gets `metadata.idle_ms`. It is not killed: that is the user's call to make, visibly, through the H3 now-line.
- **Files:** `src/tools.rs` (incremental reader, heartbeat ticker, new default), `src/main.rs` (ticker wiring in the tool runner), `mock/mock_upstream.py` (`tool:` script for `sleep 45` and an output-dribbling command), `tests/h1-liveness.sh`, and `verify.sh` (calls it).
- **Cuts:** no PTY; no interactive stdin; no output-quiet kill.
- **Verify (hard):** `cd ~/Work/bifrost/lab/yggdrasil && for i in 1 2 3; do ./tests/h1-liveness.sh || exit 1; done && ./verify.sh`
  The assertions:
  1. A silent `sleep 45` yields ≥ 8 running heartbeats on `/event`, each carrying `"sessionID":"ses_`.
  2. A `sleep 150` completes under the default config (it would have timed out before).
  3. The M0 rig re-run against **real yggdrasil** with `OC_STALL_MS=20000` and a 45 s silent tool shows no abort in the PWA `.diag`.
  4. Stored transcripts keep the opencode part shape (the slice 6a/7 shape check).
- **Evidence:** `receipts/h1-liveness.json`, with heartbeat count, max gap between events, and the PWA watchdog lines.
- **Online check:** Claude Code's bash `run_in_background` auto-backgrounds after 120 s; opencode streams bash output through part metadata. **We keep the turn alive instead of backgrounding by default.** In the life, the user's runs *are* the long tool; backgrounding goes to H6's `job` tool, where the agent chooses it.

### H2 — asks and edges: no hidden waits

- **Answers:** P2 (12 of 14 asks died) and P1's permission class (57 of the 73 kills). It also implements SELF.md promise 4, "the gate at the edges".
- **Goal:** when the agent needs the user, the run **parks visibly** and keeps the session alive. The user answers by talking. Only the user's named edges ever stop a command.
- **Mechanism:**
  - **`ask` tool** (opencode's `question`, done right). It parks the run, publishes `ask.open {sessionID, askID, question, options[]}`, and repeats `ask.waiting` every 60 s. The repeat is a truthful heartbeat: waiting on you is not wedged.
  - **The next user message to that session is the answer.** It is delivered as the tool result; it is not queued behind the parked run. `POST /session/:id/ask/:askID {answer}` exists for taps.
  - `GET /ask` lists every open ask on this tree: the inbox.
  - **Edges.** The user's layer is `data/self/edges` (or `YGG_EDGES`): one case-insensitive substring per line. A matching bash command parks with `gate.open {sessionID, gateID, command, why, scope}`.
    - **Decide explicitly:** `POST /session/:id/gate/:gid {decision:"allow"|"deny", note}`.
    - **Next message instead:** if the user sends a new message instead of deciding, it counts as **deny + note**, and the run continues with the user's words. This is the safe default; it never wedges.
    - **No timeout.** Parked is not wedged.
  - **Seed edges**, taken from the life and offered to the user, not imposed: `git push`, `npm publish`, `promote.sh`, `systemctl --user restart lk-`, `systemctl --user stop lk-`, `rm -rf ~/`, and any `scp`/`rsync` to `veraldar:` (publishing).
  - **No path fence.** The 57 deaths were reads and installs outside `~/Work`, and those are not edges.
  - `session.info.waiting = {kind:"ask"|"gate", text, since}` is an additive field. `GET /session/status` keeps reporting `busy`, so the PWA stays coherent.
- **Files:** `src/tools.rs` (`ask`), `src/main.rs` (park and resume on the run lock, next-message routing, `/ask`, gate routes, edges file), `mock/mock_upstream.py`, `tests/h2-asks-edges.sh`, `verify.sh`.
- **Cuts:**
  - No per-tool approval modes.
  - No regex edges (substring only; that limit is stated in the edges file header).
  - No push notification: the bridge owns push, which is a product lane.
  - No risk scoring beyond the `why` line.
- **Verify (hard):** `cd ~/Work/bifrost/lab/yggdrasil && for i in 1 2 3; do ./tests/h2-asks-edges.sh || exit 1; done && ./verify.sh`
  The assertions:
  1. A scripted `ask` appears in `GET /ask` and parks 30 s with ≥ 1 `ask.waiting` heartbeat. Posting the plain user message "call it bifrost" resumes the run, and the tool result equals that text. The reply completes, `message.completed` fires once, and the busy map ends empty.
  2. A `git push` command parks. `deny` gives an error tool part carrying the note, and the run continues to a final reply. `allow` actually runs the command (a marker file appears).
  3. With a gate parked, a new message is recorded as deny + note, and no command runs.
  4. The M0 rig with `OC_STALL_MS=20000` shows that a 45 s parked ask is not aborted.
  5. After a restart, an open ask is re-listed from disk, because parked state persists.
- **Evidence:** `receipts/h2-asks-edges.json`.
- **Online check:** opencode upstream emits `permission.asked/replied` (so an opencode-side fix exists, but it needs PWA code). Claude Code Remote Control pushes prompts to the phone. LangChain's ambient pattern names the modes notify / question / review. **Kept from them:** an inbox (`GET /ask`) and a risk line on gates. **Diverged from them:** answers arrive as plain talk, and gating happens only at the edges (the life, see §5).

### H3 — the now line

- **Answers:** P3 (27 bare polls; p90 turn of 13 min) and P7 (refusals in plain words).
- **Goal:** each session can say in one sentence what it is doing right now. The phone can show that sentence, and the voice can speak it.
- **Mechanism:**
  - `GET /session/:id/now` returns `{state:"working"|"waiting"|"idle"|"error", since, line, tool?, elapsed_ms?}`, built only from harness truth: the running tool's title, its elapsed time, its last output line, the parked ask's question, or the last error.
  - Example lines: `running cargo build — 6 min, last: Compiling str0m v0.24`; `waiting on you — "which name for the repo?" — 4 min`; `done — 2 lines, 3 files changed`; `brain refused: credit balance too low (anthropic) — switch model or top up`.
  - `GET /now` returns every session's line: the tree's pulse.
  - The event `session.now` fires on every change and every heartbeat.
  - On completion, `run.done {sessionID, ms, summary}` carries the final text's first sentence, ≤ 140 chars.
  - **Provider refusals** (401/402/429/"credit"/"unknown model") end the run with `info.error.name="ProviderError"` and the provider's own words in the now line. The busy map ends empty.
- **Files:** `src/main.rs` (now-line store fed by the run/tool/ask state machine), `tests/h3-now.sh`, `verify.sh`.
- **Cuts:**
  - No LLM-written summaries (truth only; the model's own words appear only through `run.done.summary`).
  - No i18n server-side: lines are English facts, and the bridge translates labels, not facts.
  - No notification fan-out.
- **Verify (hard):** `cd ~/Work/bifrost/lab/yggdrasil && for i in 1 2 3; do ./tests/h3-now.sh || exit 1; done && ./verify.sh`
  The assertions:
  1. During a scripted 20 s tool, two polls of `/now` 5 s apart show the same tool and an `elapsed_ms` that grew by ≥ 4000.
  2. An ask makes the line start with `waiting on you`.
  3. After completion, `state=idle` and `run.done.summary` is non-empty.
  4. A mock `mock-402-credit` key gives `state=error` and a line containing `credit`, with the busy map empty and no zombie placeholder.
- **Evidence:** `receipts/h3-now.json`, with a transcript of now lines over a scripted run.
- **Online check:** narration tools ("Heard", 2026) narrate by salience, not by verbosity. The ambient-agent "notify" mode is cheap trust. **Kept:** one line, from state, not prose.

### H4 — the life comes along (import)

- **Answers:** P6 and promise 1, "a session ending is not death". Flipping the brain without the 223 sessions is amnesia, and MAIN (`ses_f28e2fdf4ffeWng5LZZnYbCpnm`) is the self the user talks to.
- **Goal:** yggdrasil opens with the whole opencode life readable, searchable, and continuable.
- **Mechanism:**
  - `yggdrasil import-opencode --db <path> [--since …]` reads the store **read-only** (sqlite `mode=ro`, through a vendored `rusqlite`).
  - It writes yggdrasil session files in the existing opencode shape: parts kept byte-faithful, `parentID` kept, and `time` kept. Reasoning parts are kept but marked `imported`.
  - It is idempotent: sessions are keyed by id, and a re-run only appends new messages.
  - The first turn on an imported marathon triggers the 6b roll-up before the upstream call, so MAIN continues within limits.
  - One brain per store (STABLE.md rule 6): the import is a copy. opencode's store is never written.
- **Files:** `src/import.rs` (new), `src/main.rs` (subcommand), `Cargo.toml` (`rusqlite` with `bundled`), `tests/h4-import.sh`, `verify.sh`.
- **Cuts:** no live two-way sync; no event-table import (it is derivable); no import of opencode's permission/project tables.
- **Verify (hard):** `cd ~/Work/bifrost/lab/yggdrasil && for i in 1 2 3; do ./tests/h4-import.sh || exit 1; done && ./verify.sh`
  The test runs against a **copy** of the store (`sqlite3 .backup` into a temp dir). The assertions:
  1. Session count and message count equal the copy's.
  2. 50 random messages have identical text parts.
  3. `GET /session/:id/message` on MAIN returns its last message.
  4. A mock turn on MAIN logs exactly one roll-up call, then completes.
  5. A re-run adds 0 sessions.
- **Evidence:** `receipts/h4-import.json`, with counts, sample hashes, and the roll-up tokens before/after.
- **Online check:** Letta's memory blocks and sleep-time consolidation. **Kept for H7:** consolidate while idle. **Here:** only make the past addressable.

### H5 — the flip is earned: life-replay A/B (the Rust evidence trigger)

- **Answers:** vision.md's line *"Yggdrasil = … opencode today; a Rust-optimized one-click build is the evidence-triggered evolution"*. The Rust core exists in the lab (sunk cost). **Rust in the user's daily life is gated by this slice's evidence, not by architecture taste.**
- **Goal:** run the top frictions as scenarios against **both** brains and let the result decide whether yggdrasil enters the STABLE.md v0.7 rung (`next` slot :8443, then live).
- **Mechanism:** `lab/yggdrasil/replay/ab.sh` runs six scenarios, each derived from cited life evidence:
  - R1: a 45 s silent tool, under `OC_STALL_MS=20000`.
  - R2: a read outside the project dir.
  - R3: the agent asks; the user answers by the next message.
  - R4: a bash call over 120 s with output.
  - R5: a provider refusal.
  - R6: a marathon resume past the context limit.

  Each runs against (a) an opencode-serve **lab instance** in a netns (never :4096) configured with the **best config-only relief** (`external_directory` allow-list widened, `question` denied) and the mock as an openai-compatible provider, and (b) yggdrasil at H1–H4. The script writes `replay/ab-verdict.json`.
- **Decision rule:** the **GO** for v0.7 requires both of these:
  - yggdrasil passes 6/6;
  - opencode fails ≥ 2 scenarios that config can't fix.

  Otherwise the verdict is **HOLD**: ship the config relief to the live opencode (an open question, below), and keep Rust in the lab. Both outcomes are honest. The user gates the promotion (STABLE.md: a week in the next slot, `--rollback` ready).
- **Files:** `replay/ab.sh`, `replay/opencode-lab.json` (lab opencode config), `replay/scenarios/*.sh`.
- **Cuts:** no real-provider A/B (budget). A single real-model smoke runs only if the GO is reached, through `verify-real-upstream.sh`.
- **Verify (hard):** `cd ~/Work/bifrost/lab/yggdrasil && ./replay/ab.sh && python3 -c "import json;v=json.load(open('replay/ab-verdict.json'));assert v['verdict'] in ('GO','HOLD') and len(v['scenarios'])==6"`
- **Evidence:** `replay/ab-verdict.json` and the per-scenario logs.
- **Risk:** opencode may not run against the mock cleanly (provider shape). The fallback is R1–R3 only, against a real provider at small budget. That fallback is a stated deviation in the verdict.

### H6 — sessions and jobs are the agent's own

- **Answers:** P4: 540 back-door curls, 201 `claude -p` calls, 269 detaches, 212 sleep-polls. It also implements SELF.md promises 2 and 3, roles gone and each owns its layer.
- **Goal:** the agent does natively, measured, what it already does by hand.
- **Mechanism:**
  - **Session tools:** `session_spawn`, `session_post`, `session_read`, `session_seal`. They come from `stash@{0}`; pop it if it survives review, rewrite if not. Spawned sessions carry `owner:"agent"` and API-created ones carry `owner:"user"`. The agent cannot delete.
  - **`job` tool** for long ops that should outlive the turn: `job_start {command, title}` returns a `jobID` at once.
    - The job runs in its own process group under the tree, not the turn, so an abort doesn't reap it. This is Rule 10-04.3, "every long op detached", made a primitive.
    - `job_status` and `job_tail` read it. Completion posts a `job.done` note into the owning session and wakes it when idle.
    - `GET /jobs` lists all jobs, and the H3 now line includes running jobs.
  - Owner and job counts appear in `GET /now`.
- **Files:** `src/selfstore.rs` and `src/tools.rs` (from the stash, reviewed), `src/jobs.rs` (new), `src/main.rs`, `tests/h6-sessions-jobs.sh`, `verify.sh`.
- **Cuts:** no parallel worker pools; `session_post` stays serial and refuses a busy target (SELF.md honest edge); no cross-tree spawn (H8).
- **Verify (hard):** `cd ~/Work/bifrost/lab/yggdrasil && for i in 1 2 3; do ./tests/h6-sessions-jobs.sh || exit 1; done && ./verify.sh`
  The assertions:
  1. The agent spawns a child, posts to it, and reads the reply back. The child has `owner=agent` and `parentID` set.
  2. A 40 s job outlives an **abort** of its turn (its pid is alive after the abort).
  3. Job completion posts `job.done` into the owner session, and the session wakes and replies.
  4. `DELETE` is refused from the agent path, and only `DELETE /session/:id` (the user layer) removes.
- **Evidence:** `receipts/h6.json`.
- **Online check:** Claude Code background tasks and subagents; Codex exec. **Diverged:** sub-sessions are persistent transcripts the user can open, not hidden workers.

### H7 — the self: doctrine, memory, corrections, the intention echo

- **Answers:** P6, the memory quotes, and promise 4: the echo, and trust that compounds. It also answers the user's "transparency" asks (`msg_10d6ec2060012vmrhluzJrtE20`).
- **Goal:** what the tree knows about the user lives outside any context, is visible, and corrects itself.
- **Mechanism (from the stash's selfstore.rs, reviewed):**
  - `data/self/doctrine.md` holds a `## THE LAW` section that is user-only and a `## THE SELF` section the agent edits through `self_write`, versioned.
  - `remember` and `recall` cover memory notes **and** every session, including the imported life.
  - `POST /session/:id/correct` writes a correction; the 10 most recent corrections ride in every run.
  - The `intention` tool emits `intention.echo` at the start of a run (one line: "understood: X, for Y").
  - `GET /self` returns the whole self.
  - **Sleep-time consolidation** (from PATH A, Letta): when the tree has been idle 30 min, one cheap upstream call proposes memory merges. Those are written as *proposals* in `GET /self`, never applied silently.
- **Files:** `src/selfstore.rs`, `src/tools.rs`, `src/main.rs`, `tests/h7-self.sh`, `verify.sh`.
- **Cuts:** no semantic search (word scorer, stated); no automatic memory deletion; no persona/voice in the tree (voice is the bridge's, STABLE.md).
- **Verify (hard):** `cd ~/Work/bifrost/lab/yggdrasil && for i in 1 2 3; do ./tests/h7-self.sh || exit 1; done && ./verify.sh`
  The assertions:
  1. A correction posted on session A appears in the system block of the next run on session B (mock echo).
  2. A `self_write` that touches `THE LAW` is refused.
  3. `recall "booking link"` finds an imported-life session (needs H4).
  4. `intention.echo` precedes the first delta on every run.
  5. `GET /self` lists doctrine, edges, memory count, corrections and pending gates.
- **Evidence:** `receipts/h7.json`.

### H8 — federation: one list, every tree

- **Answers:** P5 (527 ssh calls) and the vision.md "PIVOT 10-02 (user): federation, not switching".
- **Goal:** the home tree's `GET /session` returns every session from every reachable peer tree, each labelled. Posting to a peer's session reaches that peer, server to server, over the tailnet.
- **Mechanism:**
  - `YGG_TREE_NAME` and `YGG_TREE_GLYPH` identify the tree.
  - Peers start static (`data/self/peers`: `name url token`). Discovery is the second step: `tailscale status --json` lists peers, and each is probed on the yggdrasil port with `GET /tree`.
  - Peer auth is an **instance token**, the same seam as S1 (`lib/devices.ts`-shaped hash registry on the tree).
  - The list merge fans out in parallel with a **2 s per-peer timeout**. Each session gets `tree:{name, glyph, state}`. An unreachable peer gives `tree.state:"unreachable", reason`: a grey chip, never a spinner.
  - The router maps a session id to its owning peer (ids are 128-bit random, so collisions are negligible) and forwards message, abort, now and ask calls.
  - `GET /ask` and `GET /now` fan out too, which gives one inbox for the world.
  - Optional zero-PWA-change interim: `YGG_FED_TITLE_PREFIX=1` renders `studio · title`, stripped on PATCH. It is off by default.
- **Files:** `src/federation.rs` (new), `src/main.rs`, `tests/h8-federation.sh`, `verify.sh`.
- **Cuts:** no cross-tree move/merge of sessions; no shared presence; no relay of voice (owning-tree rooms, spec-bridges.md); no bifrost-net transport (tailnet only; bifrost-net stays out of the critical path).
- **Depends on:** the instance-token seam. Its decision is open question Q1.
- **Verify (hard):** `cd ~/Work/bifrost/lab/yggdrasil && for i in 1 2 3; do ./tests/h8-federation.sh || exit 1; done && ./verify.sh`
  The setup: two yggdrasil instances on loopback (`omarchy` :14101, `studio` :14102). The assertions:
  1. The merged list on :14101 has both trees' sessions with correct labels.
  2. A post to a studio session lands in studio's store.
  3. After `kill -STOP` on the studio instance, the list returns in < 2.5 s with studio `unreachable`.
  4. A wrong token gives `tree.state:"unreachable", reason:"token revoked — re-pair"`, with no 401 cascade.
  5. The PWA referee pointed at :14101 still passes ≥ 38.
- **Evidence:** `receipts/h8.json`.

### H9 — the tree is the door (harness side of first-run)

- **Answers:** vision.md "The tree is the door (10-02, user)" and the persona evidence (`msg_1024abe9e001K72LG1EZyOxRtL`, `msg_10253aafa001H2MDDRm51vRi2L`).
- **Goal:** one idempotent call plants MAIN, and the onboarding's answers become the first facts of the self.
- **Mechanism:**
  - `POST /door {language, voice:"woman"|"man", name?, provider}`. The first call creates `[MAIN]` with `reserved:true` and writes the answers as `kind:"fact"` memory notes plus `self.prefs`. Every later call returns the same MAIN id.
  - MAIN can't be deleted except with `DELETE /session/:id?reserved=confirm` (the user layer).
  - The voice preference is **stored by the tree and rendered by each bridge**, so every bridge on every phone uses the same persona (TTS stays in bifrost).
- **Files:** `src/main.rs`, `src/selfstore.rs`, `tests/h9-door.sh`, `verify.sh`.
- **Cuts:** the phone-side door UX waits for the pick (§4); no VPS/bifrost-net onboarding branch (v0.9, vision.md).
- **Verify (hard):** `cd ~/Work/bifrost/lab/yggdrasil && for i in 1 2 3; do ./tests/h9-door.sh || exit 1; done && ./verify.sh`
  The assertions:
  1. Two `POST /door` calls return the same id.
  2. `GET /self` has `prefs.voice`.
  3. A plain `DELETE` on MAIN gets 409, and `?reserved=confirm` gets 204.
  4. On the mock, the first run in MAIN carries the facts in its system block.
- **Evidence:** `receipts/h9.json`.

### Order and dependencies

```
H0 ─► H1 ─► H2 ─► H3 ─► H4 ─► H5 (GO/HOLD: Rust enters the life?)
                              │
                              └─► H6 ─► H7 ─► H8 (needs Q1) ─► H9 (phone side needs the UX pick)
```

H1–H3 are the v0.7 gate's own words in STABLE.md ("every turn ends — reply or explicit error, never a silent hang"). H4 and H5 decide the flip. H6–H9 deepen the self once the flip is earned.

---

## 3. Where Rust enters (the evidence trigger, explicitly)

- **Rust in the lab: already done.** `lab/yggdrasil` is a Rust server, slices 1–7, 8.1 MB. That is not the decision.
- **Rust in the user's life: H5's verdict only.** If GO, yggdrasil becomes the brain behind the `next` slot (STABLE.md v0.7, opencode kept running all week, `--rollback` ready). If HOLD, the config relief ships to opencode, and the Rust core keeps evolving in the lab against `ab.sh` until the evidence changes.
- **The "one-click build" (PKGBUILD, static binary) enters the life only with H9 plus the door onboarding**, triggered by a second tree's install (the TV-PC or the girlfriend test, STABLE.md v0.8/v1.0). It is not built before a second install exists to measure it.
- **bifrost-net (boringtun + str0m, M0/M1 FEASIBLE) stays out of this plan's critical path.** Federation (H8) rides the tailnet. The transport swap is the v0.9 rung.

---

## 4. UX evolution propositions (same brand, three distances)

Each artifact is self-contained: one HTML file, offline, EN/FR toggle, woman/man persona toggle, phone frame first with a desktop frame beside it. Reloading resets it. The data is scripted and labelled as scripted: real session titles from the store, states played by a script. **The look is frozen (v0.6.0 HLIÐ tokens, state law green alive · amber heard · red stop · sky know, square hairlines, `## ` heads, the tree's motion law). Only interaction and structure change.**

| | **NEAR** `yggdrasil-ux-near.html` | **MID** `yggdrasil-ux-mid.html` | **FAR** `yggdrasil-ux-far.html` |
|---|---|---|---|
| interaction model | today's screens and gestures, three evolutions: **now lines** on rows (hold a row to hear it), **asks answered by talking** (sky card in chat, a hold answers), **long runs that stay alive** (heartbeat in the phase line; a side-by-side "today vs harness" at 10:00) | **structure changes**: the **tree-is-the-door first run** (hold the tree, a voice onboarding picks language and voice persona, "planted", the tree shrinks to the header and always opens MAIN); **one federated list** (rows carry tree chips; "waiting on you" first across trees; an unreachable tree is a grey chip with a reason); a **while-you-were-away** line on open | **the tree is the agent**: a world canvas of trees joined by roots (one per PC), each following the motion law; **knock a tree to open its bridge**; **hold anywhere to talk**; sessions as branches (yours vs the agent's); **the self panel** (law, self, memories, corrections — strike a memory as the user; the agent can't); **ask the world**: one sentence routed to the tree that owns it |
| what changes | row subtitle, ask card, phase-line text | first-run gate, list structure (grouping + tree labels), open-time digest | the home screen paradigm (canvas instead of list), voice as the default input, the self made visible |
| what stays | everything else: list, band, chat, dock, rail, settings, artifacts | chat screen, dock, rail, settings, artifacts gallery, state law | tokens, palette, state law, tree drawing, copy law; the list remains one swipe away |
| harness needs | H1, H2, H3 | H1–H3, H8, H9 (+H4 for the history) | all of H1–H9 |
| product cost (est.) | small: 3 components, about 2–3 days with e2e | medium: first-run route, list rework, a federation client, about 6–9 days | large: new canvas, voice-first input rework, self panel, about 3–5 weeks; needs bifrost v0.6.2 speech (French STT not yet passing) |
| unlocks | ends "done?" polling and dead asks on today's flow | one world view (the vision pivot); first-run for new users (the girlfriend test) | the harness-is-identity story made tangible; multi-tree voice |
| risks | now lines lie if the harness state is wrong (mitigated: built only from tool truth) | first-run gate blocks power users (mitigated: the door is skipped when MAIN exists); federation latency (2 s cap) | discoverability; voice-only failure in noisy rooms (a keyboard key stays); canvas performance on old phones; brand drift (a new canvas, same law, reviewed against `docs/brand/review-checklist.md`) |

**Pick-independence line:** the harness core (H0–H9 tree side) does not depend on the pick. The pick decides only which `pwa/` work follows. NEAR can ship on H1–H3; MID waits for H8 and H9; FAR waits for all of them plus v0.6.2 speech.

---

## 5. Dual-path note (Rule 10-06)

- **PATH A (online, 10-07, query pool in §6) said:**
  - Asks must reach the phone. Claude Code Remote Control pushes permission prompts, and Forge-class apps show risk levels.
  - opencode upstream exposes `permission.asked/replied`, so the P1 permission class *is* fixable on opencode, but only with product code.
  - Long commands auto-background (Claude Code, after 120 s).
  - Memory lives in blocks, consolidated while idle (Letta).
  - Ambient agents use notify / question / review plus an inbox (LangChain).
  - Voice narration works by salience ("Heard").
- **PATH B (the life) said what A could not:**
  - **78 % of watchdog kills are the permission class** (57/73).
  - The user's asks were **names and design picks answered by talking**, not approvals.
  - The user wants **edges, not per-tool approval** (`msg_101ba935a001ADJhmzpTnikQJ0`, `msg_0b01d750e001YpO4nTevwjxg75`).
  - Agents **already self-orchestrate** (540 curls, 269 detaches), so the need is native primitives, not new behavior.
  - **Federation is lived** (527 ssh).
  - The **MAIN context cliff** (919k of 1M, 0 compactions).
- **The merge (what ships):**
  - From A: the inbox (`GET /ask`), the risk line on gates, jobs as a primitive, sleep-time consolidation as *proposals*, the salience-first now line.
  - From B: next-message-answers, edges-not-paths, heartbeats instead of auto-backgrounding the user's main work, import-the-life before any flip, tree-side federation.
- **Where A and B disagree, B wins for this user:** per-tool approval modes (Codex, Forge) versus edge-only gating.
- **The inference gap A exposed in B:** the opencode-side permission events. Hence H5 compares against opencode's *best* config, not its default, to keep the Rust trigger honest.

---

## 6. Online check log (Rule 10-05.2: the query pool, 2026-10-07)

1. `opencode server permission.asked event respond permission API external_directory` → opencode docs (permissions) and codeongrass.com (mobile approval queue from permission events)
2. `Claude Code mobile remote approve permission requests push notification phone 2026` → Remote Control; Forge Remote; claude-remote-approver (ntfy)
3. `agent inbox UX pattern human-in-the-loop interrupts ambient agents …` → LangChain "UX for Agents, Part 2: Ambient"; tiered-escalation write-ups
4. `Letta memory blocks sleep-time agent persistent memory across sessions harness` → letta.com memory blocks; Letta Code
5. `coding agent background shell long-running command heartbeat output streaming run_in_background Codex Claude Code` → Claude Code `run_in_background`; pi background tasks
6. `voice-first mobile coding agent UX 2026 hands-free status narration …` → "Heard" voice companion; Codex Realtime V3 voice; Claude Code voice-mode issues

The pool is small on purpose (cost law). Each slice's BUILD run repeats its own online check and appends to this log in its receipt.

---

## 7. Open questions (to land in `docs/open-questions.md`)

| # | question | why it matters | recommendation |
|---|---|---|---|
| Q1 | **Federation topology:** tree fan-out (vision.md PIVOT 10-02: the phone's instance fans out server to server) or client fan-out (spec-bridges.md 10-04: the PWA holds one token per tree, CORS)? The two documents disagree. | H8's shape; who holds peer tokens; whether the PWA list code changes | **Tree fan-out.** The phone keeps one URL and one token, the one seam holds, and the PWA list changes by one label. |
| Q2 | **Apply config-only relief to the live opencode now?** Widen `external_directory` (today `"*":"deny"`, which converts hangs into refusals) and deny `question`. | P1 and P2 on the live brain *this week*, independent of the Rust flip | Yes, as a reversible `opencode.json` edit with a backup. The user gates it, because it widens reach. |
| Q3 | **MAIN's context cliff on the live brain:** 919,579 / 1,000,000 tokens, +35k/day, never compacted. Does GLM 5.3 Flash really accept 1M, or will the turn fail before opencode compacts? | The user's main session may break within days | Watch it. A manual `/compact` or a fresh MAIN with a carry note before 980k. **Flagged BLOCKED=VISIBLE to the coordinator.** |
| Q4 | Seed edges list: accept the 7 proposed edges (H2), edit, or start empty? | What stops without asking | Accept the proposal; the user edits `data/self/edges` any time. |
| Q5 | Should a parked gate ever expire? | The run lock is held while parked | No expiry. A new message counts as deny + note, so it never wedges. |
| Q6 | Federation peers on opencode (the Mac Studio today) — via its bridge's `/api/*` with a device token, or only yggdrasil peers? | Whether H8 helps before the Studio runs yggdrasil | Accept both: the peer adapter speaks the opencode surface, and yggdrasil is opencode-compatible. |
| Q7 | The UX pick: NEAR, MID, FAR, or NEAR now plus MID next? | Which `pwa/` lane follows | NEAR now (fast relief on H1–H3), MID as the v0.8 structure. FAR as the north-star canvas, evaluated after a week on MID. |
| Q8 | Voice persona default for new users at the door: ask always, or default woman (the user's pick) for this tree only? | First-run wording | Ask always for new trees; this tree keeps the user's stated pick. |

---

## 8. Risks of this plan

- **M0 fails:** the watchdog ignores tree heartbeats. H1 and H2 then need product code; the fallback is in H0.
- **opencode doesn't run against the mock in H5:** the A/B degrades to R1–R3 on a real provider, and the verdict must state the deviation.
- **Proxy-green contamination** (Rule 10-05): every check here is mock-driven. The real-model smoke (`verify-real-upstream.sh`) runs only at GO, and real use for a week in the `next` slot is the external truth.
- **Import size:** the store is 533 MB. A naive import doubles the disk use and slows startup. H4 must stream it and lazy-load at startup (measure it).
- **The stash may not survive review** for H6/H7. Budget a rewrite.
- **The store is moving under the plan:** the counts grow daily. `life-probe.py` re-derives them; the classes and ranking are the claim, not the exact numbers.

---

## 9. What I could not do, and why

- **I did not run M0 or any slice.** This run is plan-only by order, and M0 is the [BUILD] session's first act. Every verify command above is specified, not executed.
- **I did not inspect `stash@{0}`'s patch.** My order was no git operations beyond read-only listing (`git log`, `git status`, `git stash list`). H6/H7 rely on SELF.md's description of it.
- **The coordinator's brief `prompts/ygg-rework-plan.txt` asked for `lab/yggdrasil/REWORK-PLAN.md` and a commit.** This run followed the newer user brief instead: `docs/yggdrasil-harness/`, no commits.
- **Some evidence is inferred, not proven.** The permission-ask attribution of the 57 kills rests on path patterns plus the fleet's own diagnosis (`docs/claims.md:71`). opencode does not persist permission events in its store (the `permission` table holds 0 rows; no `permission.*` event rows exist).
- **The voice-transcript count (≥ 113) is a heuristic** (fillers plus sentence shape). The store does not mark which prompts were spoken.
- **The online check is a 6-query pass,** not a deep survey. Sources were search summaries, not full reads.
- **The UX artifacts have not been tried on a real phone.** I checked them in headless Chromium at phone and desktop sizes. Their speech uses the device's local system voice when one exists; it is not bifrost's TTS.

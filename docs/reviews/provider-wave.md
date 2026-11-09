# PROVIDER-WAVE — providers, visibility, locations, two roots (10-28)

Session PROVIDER-WAVE (opus, the user's orders 10-28). A duplicate lane B was dispatched 42 s after
this one. It wrote a 3+4 split claim, then its unit was stopped at 20:40:20 (`systemctl stop`). This
lane did all four items.

## 0 · Verdict

| item | state | where |
|---|---|---|
| 1 provider system (root) | **DONE, e2e 14/14**. Not on :4100 yet: the deploy is the human-gated runbook in §5. | trunk `45f7264` `7a3ad80` `8bfd54f` (`lab/yggdrasil`) |
| 2 error visibility | **DONE, e2e GREEN.** Root side: the error turn. PWA side: the banner. Three combinations tested (new root + new PWA, frozen root + new PWA, new root + frozen live PWA). | trunk (root) + `wave/provider-banner` `1a073ed` `6e4ee9c` `5e6b1e7` (pwa, off `release/v0.7`) |
| 3 location audit | **DONE.** The doc, plus the safe fixes applied with no process changed: the bridge's deleted binary frozen, 9 secret files set to 0600, `where.sh` shows the next slot truthfully. The root env move and the rollback-brain pin ride your deploy window. | `docs/reviews/locations-audit.md` |
| 4 two-roots law | **DONE, guard test 19/19.** `:443`/`:8443` are different today. | trunk `42d1263` |
| bonus: ONE root binary | tool-scope (the last AGI work in MAIN, GREEN, waiting for your review) merged with this wave. All four suites green on the merge. | `wave/root-provider-toolscope` `c273bb6` `885122c` |

**Why the tree went blind (10-28 ~20:23–20:33).** z.ai answered every turn with `429` code `1310`
("Weekly/Monthly Limit Exhausted … reset at 2026-10-29 03:44:03", which is Beijing time, so 20:44 CET).
The root stored the reason in `info.error` of an assistant message whose only text part was empty.
The PWA's transcript filter drops empty messages. The send itself got a bare `500`, and the page
shows that as "no reply — opencode 500 on /session/…" only if the page was open at that moment. Seven
"yo?"/"where are we at?" turns got seven empty answers.

**Where MAIN's AGI work stood (read first, not redone).** Its last board, 20:35:
- TOOL-SCOPE GREEN on scratch :4101, waiting for your plan review, then its :4100 runbook.
- artifacts-wire died with no report and is on the requeue list.
- tool-policy is blocked on quota.
- rule-eval is MEASURING until 11-04.

This wave touches the same root binary as tool-scope. Shipping them separately would make the second
deploy drop the first one's features. They are merged into one candidate instead (§5, option B).

## 1 · The provider system (the root, yggdrasil)

### Spec — the config layer (parity with opencode)

**One file, opencode's shape.** opencode users can paste their `provider` block as-is. yggdrasil adds
`fallback` and `dialect`. Path: `YGG_PROVIDERS`, else `~/.config/yggdrasil/providers.json`. The file
is read only if present and re-read when its mtime changes, so an edit lands on the next run with no
restart. A broken edit keeps the last good registry, and `GET /provider` reports it as `reloadError`.

```json
{
  "model": "yggdrasil/glm-4.6",
  "fallback": ["ollama/qwen3:8b", "openrouter/z-ai/glm-4.6"],
  "provider": {
    "ollama":     { "options": { "baseURL": "http://127.0.0.1:11434/v1" }, "models": { "qwen3:8b": {} } },
    "openrouter": { "options": { "apiKey": "{file:~/.config/yggdrasil/openrouter.key}" }, "models": { "z-ai/glm-4.6": {} } },
    "mine":       { "npm": "@ai-sdk/anthropic", "options": { "baseURL": "https://…", "apiKey": "{env:MY_KEY}" },
                    "models": { "m1": { "name": "M One" } } }
  }
}
```
(full example: `lab/yggdrasil/providers.example.json`)

- **Sources.** The env provider `yggdrasil` (`YGG_UPSTREAM_*`, exactly the pre-wave single upstream)
  is merged with the file. A file entry with id `yggdrasil` replaces it. `YGG_FALLBACK=pid/mid,…`
  overrides the file's order.
- **Dialect.** `dialect: openai|anthropic`, else derived from `npm` (`…anthropic` → anthropic), else
  from the known table. Known providers need only `models`: `ollama` (127.0.0.1:11434/v1, keyless),
  `anthropic`, `openai`, `openrouter`, `zai`, `zai-coding-plan`, each with its conventional key
  variable (`ANTHROPIC_API_KEY`, …).
- **Keys stay yours (law: your-LLM-your-key).**
  - `apiKey` is `{env:NAME}`, `{file:path}` (opencode's substitutions) or a literal.
  - A key is sent only to its provider's baseURL.
  - No endpoint ever serves a key. Status shows the key's *source* and whether it resolved.
  - The CLI refuses a key on argv (shell history), and the file is written with mode 0600.
- **Reset zone.** `options.resetTimezone` is the zone a provider prints its reset times in. The
  default is UTC+8 for z.ai/bigmodel hosts, else UTC. `YGG_UPSTREAM_RESET_TZ` does the same for the
  env provider, for a proxy in front of z.ai.

**The catalog.** `GET /config/providers` (opencode shape) is built from the registry. Its `default` holds
ONE entry, the effective default, which is what bifrost's `brain-default.ts` reads. `GET /config` →
`{model, fallback}` (opencode parity: the PWA reads `/config.model` first). `YGG_CATALOG` still
overrides the display catalog when set.

**The switch.**
- Per session: `POST /api/session/:id/model {model:{id, providerID}}` (opencode v2). Before this
  wave it was recorded and ignored; now it **routes** the run.
- Global: `yggdrasil provider use pid/mid` rewrites the file's `model`, which hot-reloads.

**The chain, and the fallback order.** Each upstream call walks this list:
1. the session's pick if it is in the catalog, else the default;
2. then the fallbacks, each target once.

A pick without fallbacks fails *as the pick*, never silently as the default.

**Classified errors.** Every upstream failure becomes a `Kind`, carrying the reset time when the
provider gives one.

| kind | from | degrades? | cools for |
|---|---|---|---|
| quota | z.ai 1310/1113/1304/1308/1309, `insufficient_quota`, 402, quota words | yes | until its reset, else 15 min |
| rate_limit | 429 otherwise, z.ai 1302/1303 | yes | reset, else 30 s |
| auth | 401/403, `authentication_error` | yes | 10 min, or until the file changes (key fixed) |
| overloaded / server | 529/503/`overloaded_error`/1305 · other 5xx | yes | 30 s |
| network / unavailable | connect fail (Ollama down) · 404 (model not pulled) | yes | 15 s |
| request / stream | 400/422 · the reply broke after it started | **no** | — |

Reset sources:
- z.ai's `reset at <datetime>` (UTC+8);
- `retry-after` (seconds or HTTP-date);
- `anthropic-ratelimit-*-reset` (RFC 3339);
- OpenAI's `x-ratelimit-reset-*` (`6m0s`);
- "try again in 20s".

When there are several, the latest wins. All parsed without a date crate.

**Fallback rule.** A degradable failure before *any text of this step* does three things:
1. It cools that provider. A cooling provider is skipped without spending a request, so stacked
   turns cost zero calls.
2. The call moves to the next target.
3. The answer is stamped: `info.providerID/modelID` = who answered, and `info.fallback` =
   `[{from, to, kind, resetsAt, headline}]`. The bus announces `provider.fallback` and `provider.status`.

A step that already streamed text is never re-asked elsewhere (no duplicated half-answers).

**Health check.**
- `GET /provider/health`: per provider, the status (ok | exhausted | limited | auth | down | error |
  unknown), plus `until`, `resetsAt`, `headline`, `lastError` and `lastOk`; `default` = the
  default's status.
- `POST /provider/check`: shallow = `GET models`, free.
- `?deep=1`: a 1-token reply. It costs one request of your plan, so it runs only on demand.
- A good probe ends a cooldown (you upgraded the plan, fixed the key, started Ollama).

**The cmd/file interface.**
```
yggdrasil provider list   [--env FILE]   catalog, default, fallback order, key sources (✓ / MISSING)
yggdrasil provider check  [ID] [--deep]  probe; exit 1 when the default is not answering
yggdrasil provider status                the running root's /provider/health
yggdrasil provider use PID/MID           default model
yggdrasil provider fallback P/M,P/M      degrade order ("" = none)
yggdrasil provider add ID --base-url URL --model M[,M] [--dialect …] [--key-env NAME | --key-file PATH]
yggdrasil provider remove ID
```
Every edit is validated the way the root would load it before it is written; a broken file is
refused. `--env` defaults to `$YGG_ENV_FILE`: pass the unit's EnvironmentFile so the env provider is
visible. The CLI says so when it is not.

**(b) the bifrost UI surface (later).** The read side is ready: `/provider`, `/provider/health`,
`/provider/check`, `/config`. The write side is the file plus the CLI today. The UI slice adds
mutation endpoints that write the same file through the same validator.

### Evidence
- `cargo test`: 14/14. The unit tests cover:
  - the exact 1310 body → quota, resetsAt 1793216643000 (= 2026-10-28 19:44:03 UTC);
  - the classification table;
  - the reset hints;
  - civil dates;
  - the registry (env only = the old single upstream; file merge; chain order; the `YGG_FALLBACK`
    override; loud bad refs);
  - the health cooldown ending at the reset.
- `lab/yggdrasil/verify-providers.sh`: **14/14** on scratch mock :4141 + root :4142:
  1. env-only boot = the old upstream;
  2. 1310 → error turn;
  3. bus events + health;
  4. SSE: the headline arrives before the error event;
  5. stacked turns never vanish, with 0 calls while cooling;
  6. the CLI hot-adds a fallback and the next turn degrades;
  7. headlines never reach the upstream history;
  8. `/provider` holds key sources only;
  9. the session switch routes the run;
  10. `provider use` moves the default live;
  11. 401 + dead fallback → the second fallback answers;
  12. the auth error turn names the key source;
  13. `/provider/check` + CLI `check`/`list`, no key printed or accepted;
  14. a broken file keeps the last good registry.
- `verify.sh` (the whole pre-wave suite, slices 1–7 + triad + OG-ctx): **PASS**. The /calls counter
  shape is untouched; the per-key counters live at `/keys`.
- Both release binaries were re-proven with `YGG_BIN=…/release/yggdrasil ./verify-providers.sh` → 14/14.

## 2 · Error visibility

**Root.** A failed run is an error TURN, never an empty reply:
- `info.error` follows opencode's shape. `APIError`, or `ProviderAuthError` for auth, carries
  `{message, kind, statusCode, code, resetsAt, providerID, modelID, isRetryable, responseBody, tried[]}`.
- A **synthetic** text part carries the headline: `⚠ provider limit exhausted, resets 2026-10-28
  20:44 CET (in 58 min)`, then `zai/glm-4.6 (429, code 1310): Weekly/Monthly Limit Exhausted.`, then
  what to do ("No fallback provider is set … yggdrasil provider add …").
  - `synthetic: true`: it is never sent upstream.
  - Markdown-safe, because the frozen PWA renders replies as markdown.
  - The provider's own reset clause (in its zone) is dropped once parsed.
- `session.error` goes on the bus (opencode's event), plus `session.state` blocked{kind, providerID,
  resetsAt, headline}.
- The SSE client gets the headline as a `message.part.delta` BEFORE `event: error`. The voice agent
  (`ask_stream`) speaks it instead of raising.
- The blocking POST answers **200 with the errored message** (opencode parity; it was 500 with a bare
  string). The voice agent's `ask()` returns the headline as its text.
- Stacked turns: each gets its own error turn. While the provider cools, none of them spends a request.

**PWA** (`wave/provider-banner`, the v0.7.1 line).
- `lib/provider-alert.ts` reads both root generations:
  - the new structured error;
  - the frozen root's `UnknownError "upstream 429 …{json}"`, from which kind and reset are recovered
    (z.ai's UTC+8 included).
- The messages route turns error messages into `{error}`; they survive the empty filter. Replies from
  a fallback carry `{via}`.
- `ProviderBanner`: **"provider limit exhausted, resets 20:44"** in the phone's clock. It re-renders
  each 30 s and ends itself at the reset.
  - It shows from the newest error turn, from a fallback reply (degraded: "answering via …"), or from
    `GET /api/provider-health` (the brain's health: out before this session even sent).
  - Dismissing it hides that alert only.
- Error turns render as the brain's notice, labelled `(brain)`. Replies from a fallback get a "via …"
  note.
- The watchdog relays `session.error` to the run-events error channel. When the frozen root answers a
  bare 500, oc-forward reads the stored error turn. A provider stop goes to the banner, not to a
  duplicate "no reply" box.

**Evidence** (scratch stacks only, `pwa/e2e/provider-banner.sh`: mock :4145 → roots :4146/:4147 → `next start` :4148/:4149):

| root × PWA | result | shot |
|---|---|---|
| new root × new PWA | GREEN: error turn + banner, `/api/provider-health` exhausted, 2nd turn → 2nd error turn, survives reload | ![banner](/api/artifact/provider-banner.png) |
| frozen root `412a9c4` (copy) × new PWA | GREEN: the same, recovered from the old error string | ![frozen root](/api/artifact/provider-banner-frozen-root.png) |
| new root × **frozen live PWA** (rc2 build 2-tWDJZQP2Pr6PIGTVDsF, a reflink copy; the release untouched) | GREEN: the 1310 stop is readable text in the transcript. **Deploying the root alone ends the blindness on today's :443.** | ![frozen pwa](/api/artifact/provider-frozen-pwa.png) |
| regression smoke (base/history/states) | the same 6 environment reds as unmodified `release/v0.7` on the same stack (no LiveKit, empty store, instant mock); history 4/4; 0 new | — |

## 3 · Location audit

Full inventory: `docs/reviews/locations-audit.md` (services → actual cwd/exe of the running PIDs, 26
working trees + stray clones, duplicates, target map, cleanup list with commands). It was drafted by a
read-only subagent, and its key facts were re-checked here (`next-slot.sh status`, `/proc/<pid>/cwd|exe`,
`git check-ignore`).

### 3a · What it found and what changed

**The one-true-location map, today:**
- **Live** (:443 → :8080, lk-pwa + lk-agent) = the frozen `~/.local/share/bifrost/live` → rc2.
- **The next slot** (:8443 → :8090) = a frozen clone `next/current` → **rc1** (`ca990ca`, switched in at
  20:34 today). Its agent runs from the same clone.
  - Different from live: the law holds. But it is OLDER than live, so **no next evolution waits on
    :8443** (§4: the check now says BEHIND).
  - The sandbox tree is only the `next-slot.sh off` fallback. `where.sh` showed it as if it were
    serving; fixed, it now shows the frozen clone.
- **The root** = the frozen binary `brain/yggdrasil-412a9c4`. **Its env is the one unfrozen piece:**
  `~/Work/bifrost/lab/yggdrasil/yggdrasil.env` sits in the trunk tree, is gitignored (so a
  `git clean -x` deletes it), and has five other readers.
- **The PWA/agent code line** is `release/v0.7`, not trunk.
- **Labs that write into trunk:** lk-verify auto-commits to whatever branch trunk has checked out
  (`31757f6` today). worldtree runs from `lab/worldtree-data`.

**Applied by this session.** None of these changed a running process; all PIDs are unchanged.
- **U4.1** bifrost-bridge was running a deleted binary from `~/Work/lane2-merge` (a crash-restart
  would have started the different on-disk build). The running bytes are frozen, read back from
  `/proc/<pid>/exe` (sha256 `104b03b4…`), into `~/.local/share/bifrost/bridge/`, with a `frozen.conf`
  drop-in that applies on its next restart.
- **C8/U2.2/U3.1** `chmod 600` on 9 world-readable secret files: 8 `.env.local` copies and
  `lk-agent-ygg.service`, which holds LIVEKIT secrets inline.
- **C10** `where.sh` shows the next slot's frozen clone when it is on.

**Deferred to your window (live/rollback units):**
- **U1.1+U1.2:** the root's env to `~/.config/yggdrasil/yggdrasil.env` plus a drop-in, with the
  worktree path as a symlink. It is byte-identical, so it can ride the root deploy restart: §5 step 2b.
- **U7:** pin opencode-legacy (the rollback brain) to the running 1.18.30 instead of mise's `latest`:
  §5 step 2c.

**Needs your go:**
- U1.3: all env readers move to the new path, including a live `--env-only` promote.
- U3.2: next-slot state out of the sandbox tree.
- U4.2: the bridge's cwd.
- U5: lk-verify off, or rehomed so it stops committing into trunk.
- U8: archive `opencode-serve`.
- U11: the 10-27 sim stack, still running.
- U12: a stray `opencode serve :4097` and `capture.py :4199`.
- C1: remove 8 clean, unused worktrees (fix-voice, fix-telemetry, fix-hf, lane3-runbook,
  ygg-vs-oc A–D). Their branches keep every commit, but the worktree dirs and their untracked files
  go, so they are listed, not deleted.
- C2–C7: dirty trees, `ygg-src` (2.0 G), /tmp scratch, harness output in `~/Work`, the old
  `~/Work/lab/yggdrasil` prototype, `livekit-opencode` (needs sudo/admin).

**DON'T:** hand-edit `next-slot.conf`; move worldtree outside its window; enable lk-pwa-lan or
fleet-watchdog; touch releases, the brain dir or the stores.

**One memory note was stale.** "lk-agent-ygg runs from lane2-merge" is true only when the next slot is
off. Corrected.

## 4 · The two-roots law

**The collapse.** On 10-27, `:8443` served v0.7.0-rc2 for the consent check, and `promote.sh` switched
`:443` to that same release: both roots on `2-tWDJZQP2Pr6PIGTVDsF`. Nothing in either script looked at
the other slot.

**The guard (`42d1263`).**
- `scripts/two-roots.sh` is the one check:
  - `check` → 0 OK / 1 COLLAPSED / 2 a slot is silent;
  - `guard live|next <release>`;
  - `same <a> <b>`.
  - "One build" = the same BUILD_ID, or two releases from one source commit (a rebuild is not the
    next evolution).
- `next-slot.sh on`: refuses live's build *before* the clone and the drop-ins; on/off/status re-check.
- `promote.sh`, a forward switch of the build `:8443` is serving (the normal consent flow):
  - It requires `--next <label|off>`, meaning where the next slot goes.
  - That target is validated BEFORE anything moves; `--next off` checks the sandbox tree's BUILD_ID.
  - After a GREEN switch, the next slot moves, then the law is re-checked out loud (RED line if
    collapsed).
- A rollback is never refused, only reported: the safety net must not depend on the other slot.
- `where.sh` shows the verdict. Today: `TWO-ROOTS OK: live 2-tWDJZQP2Pr6PIGTVDsF · next x98pDYwf55Jd18mFD3SJY — but the
  next slot is BEHIND live`.
  - :8443 serves rc1, which is older than live's rc2. That is legal but loud: the check warns
    whenever the next slot's release predates live's.
  - The fix is a v0.7.1 candidate on :8443, e.g. the banner branch: §5.
- `scripts/test-two-roots.sh`: **19/19**, hermetic (fake releases + units, scratch `/api/build`
  servers, `PROMOTE_PRECHECK_ONLY` stops before drift-guard/any switch).

**Next promotion, as typed:** `scripts/promote.sh --switch v0.7.1-rcN --next off` (or `--next <the following candidate>`).

## 5 · Deploy runbook — the human-gated steps (nothing below has been run)

:4100, :8080, :8090, :443 and :8443 were never touched by this session. Candidate binaries are staged
**inert** next to the live one: nothing references them until step 4.

| file | what | sha256 |
|---|---|---|
| `~/.local/share/bifrost/brain/yggdrasil-8bfd54f` | A: provider wave only (trunk `8bfd54f`) | `952c46a9…` |
| `~/.local/share/bifrost/brain/yggdrasil-885122c` | B: provider wave + tool-scope (`wave/root-provider-toolscope`) | `b92cbbef…` |

**Pick:**
- **A** if you have not reviewed tool-scope's plan yet.
- **B** if you have. Same window, one restart, both features; tool-scope's report §6 then needs only
  its step 3 (the profiles file) and its env line.

```bash
# 0. preconditions — the window: no run in flight, no voice room open
grep ExecStart= ~/.config/systemd/user/lk-yggdrasil.service.d/frozen.conf   # must end in yggdrasil-412a9c4
curl -s 127.0.0.1:4100/session/status                                        # must print {}
python3 ~/Work/bifrost/scripts/gate.py                                       # GREEN first
cd ~/.local/share/bifrost/brain && sha256sum -c yggdrasil-8bfd54f.sha256 yggdrasil-885122c.sha256
SHA=8bfd54f   # or 885122c (option B)

# 1. (optional) a fallback provider — without one, a quota stop is now VISIBLE but still a stop.
#    Ollama is NOT installed on omarchy; your own key works today, e.g. OpenRouter:
#      install -m 600 /dev/stdin ~/.config/yggdrasil/openrouter.key   # paste the key, Ctrl-D
#      B=~/.local/share/bifrost/brain/yggdrasil-$SHA
#      $B provider add openrouter --model z-ai/glm-4.6 --key-file ~/.config/yggdrasil/openrouter.key
#      $B provider fallback openrouter/z-ai/glm-4.6
#      $B provider check --env ~/Work/bifrost/lab/yggdrasil/yggdrasil.env
# 1b. option B only: tool-scope's profiles file + env line (its report §6, steps 3 and the printf)

# 2. store snapshot + restore proof (T13)
~/Work/bifrost/scripts/root-store-backup.sh

# 2b. (locations-audit U1.1+U1.2) the root's env out of the git tree — byte-identical, rides this restart
install -m 600 ~/Work/bifrost/lab/yggdrasil/yggdrasil.env ~/.config/yggdrasil/yggdrasil.env
printf '[Service]\nEnvironmentFile=\nEnvironmentFile=%%h/.config/yggdrasil/yggdrasil.env\n' \
  > ~/.config/systemd/user/lk-yggdrasil.service.d/env.conf
mkdir -p ~/.local/state/bifrost-backup && cp -p ~/Work/bifrost/lab/yggdrasil/yggdrasil.env ~/.local/state/bifrost-backup/yggdrasil.env.worktree-20261028
(cd ~/Work/bifrost/lab/yggdrasil && ln -s ~/.config/yggdrasil/yggdrasil.env yggdrasil.env.new && mv -T yggdrasil.env.new yggdrasil.env)
# 2c. (locations-audit U7) pin the rollback brain to the opencode it runs now (no restart needed)
mkdir -p ~/.config/systemd/user/opencode-legacy.service.d
printf '[Service]\nExecStart=\nExecStart=%%h/.local/share/mise/installs/opencode/1.18.30/opencode serve --port 4096 --hostname 127.0.0.1\n' \
  > ~/.config/systemd/user/opencode-legacy.service.d/pin.conf

# 3. switch the frozen ExecStart, ONE restart
sed -i "s|^ExecStart=%h/.local/share/bifrost/brain/yggdrasil-412a9c4\$|ExecStart=%h/.local/share/bifrost/brain/yggdrasil-$SHA|" \
  ~/.config/systemd/user/lk-yggdrasil.service.d/frozen.conf
systemctl --user daemon-reload && systemctl --user restart lk-yggdrasil

# 4. verify
journalctl --user -u lk-yggdrasil -n 6 --no-pager      # "providers: env (+ file) (default yggdrasil/…, N fallback)"
curl -s 127.0.0.1:4100/config; echo                     # {"model":"yggdrasil/glm-…","fallback":[…]}
curl -s 127.0.0.1:4100/provider/health | python3 -m json.tool | head -20
python3 ~/Work/bifrost/scripts/gate.py                  # GREEN
# then one text turn + one voice turn from the phone (rule 10-10)

# undo (either option): put yggdrasil-412a9c4 back in frozen.conf, daemon-reload, restart
```

**PWA banner → v0.7.1.** `wave/provider-banner` is 4 commits on top of `release/v0.7`. It goes into
the v0.7.1 slice through the normal door:
1. merge into `release/v0.7`;
2. `promote.sh <ref> --build-only --label v0.7.1-rcN`;
3. `next-slot.sh on v0.7.1-rcN` for your consent on :8443;
4. `promote.sh --switch v0.7.1-rcN --next off`.

The root deploy does not wait for it: §2's third row shows the frozen PWA already reads the error turn.

## 6 · Gaps, named

- **BLOCKED=VISIBLE: a real fallback needs YOUR second provider.** It needs an account or key: Ollama
  (not installed here; installing its system service needs sudo/admin), an OpenRouter/Anthropic key,
  or a second coding plan. Until then a quota stop is explained (headline, reset, what to do), not
  avoided.
- Voice: `ask()` (200 + headline) and `ask_stream()` (the delta before `error`) were checked against
  agent.py's code paths, not with a live LiveKit room. The scratch stack has no LiveKit.
- The degrade happens only before the first text of a step. A mid-stream overload ends as an error
  turn with the partial kept.
- Cooldowns are per provider, not per model. That is right for plan quotas (z.ai counts per account);
  a per-model rate limit cools the whole provider for ≤30 s.
- The `:4096` v0.6 brain (opencode-legacy, the rollback target) is unchanged. The PWA parser reads
  opencode's `APIError` best-effort.
- The verify-profiles C2 contract changed on the merge branch (a failed run → 200 + error turn, not
  500). Noted in that commit.
- The UX-CALM sim stack (`sim-ygg.service` :4111 + `sim-pwa` :8096 + mock :18190, up for a day, not
  this session's) runs the root from the trunk's `lab/yggdrasil/target/release/yggdrasil`. This
  session's `cargo build --release` replaced that file. The running process keeps the old inode
  (`(deleted)`); a restart of sim-ygg would run the provider-wave build. That build is backward
  compatible: env-only boot = the old upstream, verify.sh PASS. It was left alone; the location audit
  lists it.

## 7 · Commits

| branch | commits |
|---|---|
| `rebuild/cohesive-opus` (trunk) | `45f7264` provider system + error visibility · `7a3ad80` reset-clause · `8bfd54f` markdown-safe error text · `42d1263` two-roots guard · report + audit (this file) |
| `wave/provider-banner` (off `release/v0.7`, worktree `~/Work/bifrost-provider-wave`) | `1a073ed` banner + error turns · `6e4ee9c` frozen-PWA proof · `5e6b1e7` lint-clean |
| `wave/root-provider-toolscope` (branch only; its scratch worktree was removed after the release build) | `c273bb6` merge lab/tool-scope · `885122c` markdown-safe text (cherry-pick) |

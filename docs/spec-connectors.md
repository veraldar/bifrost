# Spec — connectors (multi-harness: opencode, Claude Code, Codex, Copilot) — POST-V1

Status: **specification only**. Raised 09-27 (user req). Lands as the
"Connectors" phase after v1.0 closes.

## Goal

The coding-agent backend ("harness") becomes pluggable:
- **globally**: bifrost has a default harness (opencode | claude-code | codex | copilot)
- **per session**: any session can override it
The phone UX, voice, queue, and transcript flow stay identical regardless of
harness. The user calls these "connectors"; in-repo: **harness connectors**.

## Non-goals (v1 of connectors)

- Voice over non-opencode harnesses (phase 5)
- Running harnesses on remote machines (they are co-located with bifrost,
  like opencode serve is today)
- Harness marketplace / arbitrary plugins — three built-ins, interface open

## Architecture

### 1. Connector interface (server-side, in the proxy seam)

Each connector implements one contract — the proxy is the only caller:

```
createSession(title) → externalId
transcript(externalId) → Msg[]            (role/text/time/queued shape)
send(externalId, parts) → run handle      (async; resolves at run end)
abort(externalId)
liveness(externalId) → live | ended       (drives queue + busy indicator)
models() → [{id, label}]                  (settings picker)
health() → ok | why-not
```

Two driver shapes:
- **http**: opencode (today's `lib/oc.ts` becomes the first connector — pure
  refactor, zero behavior change)
- **process**: CLIs driven headless — `claude -p --output-format stream-json
  --resume <id>`, GitHub Copilot CLI equivalent. Spawned, parsed, aborted by
  PID. Co-located on the box, same as opencode today.

### 2. Session identity & registry

`.harness-sessions.json` (same pattern as `.oc-live.json`): per bifrost
session → `{harness, externalId, title}`. Created lazily on first message;
harness switch on an existing session = new external session under the same
bifrost slug (transcript view stitches both, newest harness wins for new
turns — no cross-harness history copy in v1).

### 3. Global default + per-session override

- Global: single setting (server-side config file; surfaced in `/settings`)
- Per session: settings page gains a harness selector **above** model/agent;
  model list and agent list become harness-scoped (`models()` per connector)
- The settings page's existing agent picker stays — it is opencode-internal
  persona (build/plan) and only applies when harness=opencode

### 4. What changes underneath

- Queue/watchdog: proxy-owned queue stays (harness-agnostic); liveness comes
  from `liveness()` per connector (opencode keeps its SSE watchdog; Claude
  Code: process exit + stream-json events)
- Busy indicator, unread badges, push notifications: unchanged (proxy-driven)
- Voice agent: phase 5 — the Python `OpenCodeLLM` learns to call a
  harness-agnostic proxy endpoint; until then non-opencode sessions are
  text-only (voice composer shows a hint)

### 5. Spec amendment required (needs user approval at implementation)

`spec.md` rule 3 ("opencode is the source of truth for sessions") becomes:
**"the session's active harness is the source of truth for its sessions and
transcript; rooms map to sessions by slug."**

## Phases (trimmed per plan review 09-27)

1. **Core-contract extraction** (fused with connectors phase 1): connector
   interface + session registry + **golden/contract tests** ("zero behavior
   change" = golden transcripts diff clean + full e2e green). Transcript
   store / event fan-out / secrets config are extracted only as naturally
   touched — a store rewrite here would break the gate. spec.md rule 3
   amendment text is final now; applied to spec.md when this phase lands.
2. **Global default harness UI** (opencode only). Per-session override moves
   to phase 3 — it is where the stitching pain lives.
3. **Claude Code connector** (process driver) + per-session override with a
   "switched harness" marker (no transcript stitching in v1). This phase is
   the real contract evidence and the precondition for any port decision.
4. **Copilot + Codex** — deferred until claude-code proves the process
   driver AND there is demand.
5. **Voice across harnesses**.

Cuts accepted: cross-harness transcript stitching (v1 = marker only);
per-session override in phase 2; codex/copilot timing; plugin service face
post-v1 (v1 plugins = manifest + skill/cli faces only).

## Open questions

| # | Question | Candidate answer |
|---|----------|------------------|
| 1 | Copilot / Codex CLI headless streaming formats — stable enough to parse? | Spike in phase 4; fall back to pty scraping if needed |
| 2 | Attachments on CLIs (images/files)? | Claude Code: file paths on disk — write sandbox temp dir, pass path |
| 3 | Per-harness model naming collisions in the picker? | Namespaced ids (`opencode/…`, `claude/…`) |
| 4 | Does harness switch need user confirmation (context loss)? | Yes — confirm dialog naming the harness being left |

## Concept — user-local plugins (raised 09-27, not scheduled)

Users may want their own plugins that live only in **their** bifrost instance
and never touch upstream. Concept:

- a gitignored `plugins/` directory next to the repo config (survives updates;
  bootstrap creates it empty), plus per-instance config keys
- the proxy seam loads local plugins dynamically (route hooks or middleware
  list) — same trust level as the seam itself
- plugin = same contract as a connector OR a UI/route extension; exact shape
  is an open decision — name reserved: **"local plugins"**

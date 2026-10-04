# YGGDRASIL — slice 7: anthropic-compatible upstream mode (unblocks the real brain)

Slices 1-6b are green. The real upstream we must serve (zai coding plan)
speaks ANTHROPIC shape and now blocks OpenAI-shape chat completions. Add a
second upstream dialect. Land THIS slice green.

## Scope

New env `YGG_UPSTREAM_STYLE` = `openai` (default, unchanged) | `anthropic`:

- anthropic style: upstream calls `POST {base}/v1/messages` — body
  `{model, max_tokens, system, messages[], tools[], stream:true}`; auth
  headers: `x-api-key` AND `Authorization: Bearer` both sent (providers
  differ; harmless to send both). `max_tokens` is required by the shape:
  default your choice, env `YGG_MAX_TOKENS`.
- Map bifrost's internal history <-> anthropic content blocks: text parts,
  tool calls (`tool_use` blocks + `tool_result` user-side blocks for the
  loop), roll-up summary system message (`system` top-level field or first
  system message — your call, document). Tool schemas map to anthropic
  `tools:[{name,description,input_schema}]`.
- Upstream SSE (`message_start`, `content_block_start/delta/stop` with text
  deltas and `input_json_delta` for tool args, `message_delta` with
  stop_reason `tool_use`/`end_turn`, `message_stop`) maps onto the SAME
  client-facing behavior as today: deltas to the client stream, tool loop
  re-entry on `tool_use`, stored parts identical in shape to what slices
  1-6b store (a transcript must not reveal which upstream dialect served
  it).
- Abort semantics must work identically (drop upstream connection mid-SSE).

Everything else — routes, events, persistence, roll-up thresholds, client
shapes — stays exactly as is.

## Verification (your own, before you report done)

- Extend the mock with an anthropic dialect mode (serves `/v1/messages`,
  speaks the block SSE, emits a tool_use block under the same `tool:` text
  trigger, then accepts the tool_result and finishes). verify.sh gains a
  slice-7 block: full round-trip in anthropic style INCLUDING one tool loop
  step and one roll-up crossing, asserting identical stored-transcript
  shapes to the openai style. Slices 1-6b assertions stay green.
- Real-upstream hook: write `verify-real-upstream.sh` — runs the same
  round-trip against `$YGG_UPSTREAM_BASE_URL` + `$YGG_UPSTREAM_API_KEY` in
  the environment (driver supplies a working key; a 429/balance rejection
  must print FAIL-AUTH, not crash). Run it; if auth fails, leave the script
  green-checked as ready and say so in ASSESSMENT.

## Operational facts

- `source ~/.cargo/env`. Only `lab/yggdrasil/`. Product code frozen.
  `data/` holds real human sessions — tests use throwaway dirs.
- ~45 minutes. Blocked twice on the same thing: stop, write, exit.
- Append slice-7 section to ASSESSMENT.md.

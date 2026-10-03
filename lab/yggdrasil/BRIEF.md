# YGGDRASIL — slice 6a: tools + agent loop (the life of the machine)

LIFE.md in this directory is the measured usage model from real opencode
data. Read it first. The headline: 8,749 tool parts vs 5,151 text parts —
opencode's life is an agent that EXECUTES, and yggdrasil today only relays
text. Fix that. Land THIS slice green.

## Scope

Yggdrasil becomes a tool-executing agent:

- On POST message, declare a tool set to the upstream (OpenAI function
  calling) and run the loop: assistant tool_calls → execute each → feed
  results back as tool messages → repeat until a final text reply (or an
  abort / a sane max-iterations cap, your call, documented).
- Tools (schemas your design, opencode-plausible): `bash` (run a shell
  command in a configured project dir, capture stdout/stderr/exit), `read`,
  `write`, `edit` (exact string replace), `glob`, `grep`, `webfetch` (GET →
  text), `todowrite` (store the list on the session; execution = store and
  ack). Project dir: env var, default cwd. `bash` and file tools resolve
  relative paths against it.
- Every tool call is STORED on the assistant message as opencode-shaped
  parts: `{"type":"tool","callID":...,"tool":...,"state":{"status":
  "completed"|"error","input":{...},"output":...}}` — GET /session/:id/message
  must show the full tool trace. Emit `message.part.updated`-style events on
  the /event bus per tool start/finish (names your call, opencode-plausible).
- Concurrency of tools within one step: your call (serial is acceptable,
  document it).

Judgment calls are yours and go in the slice-6a section of ASSESSMENT.md:
tool schema details, loop cap, timeouts for bash, output truncation limits
(real tool outputs hit hundreds of KB — LIFE.md pattern 1), security
posture (this is a single-user box; document what you chose NOT to guard
against, like opencode's permission system — explicitly out of scope).

NOTE: `data/session/` holds REAL human sessions — tests use throwaway data
dirs only, never touch `data/`.

## Verification (your own, before you report done)

Extend `verify.sh` with a slice-6a block (mock upstream grows a tool-call
mode: first reply requests a `bash` echo tool_call, then after the tool
result returns final text):
- a message round-trip where the model calls bash → the command really ran
  (observable effect), tool part stored with input+output, final text
  delivered on the SSE stream;
- read/write/edit against a temp file under the project dir;
- loop safety: a mock that demands tools forever terminates at the cap with
  an error event, not a hang;
- slices 1-5 assertions still PASS.

## Operational facts

- `source ~/.cargo/env`. Only `lab/yggdrasil/`. Product code frozen.
- ~60 minutes — the biggest slice. Blocked twice on the same thing: stop,
  write, exit.

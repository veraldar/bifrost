# tool-policy lab — working notes

## Setup (what makes this a fair sim)
- 3 private lab roots (:4131/32/33), SAME release binary as the live root
  (md5-verified identical: 8103fb3dfd147e566db0ce5ecb6b27c9), same upstream
  (z.ai, glm-5.3-flash, anthropic dialect), same YGG_MAX_TOKENS=16384.
- Per-variant scratch fixture in /tmp/toolpolicy/<V>/ (mini brand doc with a
  deliberate typo, plan notes, seeded fake session store with one 40-day-old
  session). Live tree never in scope; lab roots never point at ~/Work.
- Soft policy = system prompt ONLY (YGG_CONTEXT_FILES), exactly the mission's
  A/B/C wording. Upstream tool declarations are IDENTICAL in all arms (all 8).
- 5 tasks × 3 reps = 45 turns; fresh MAIN session + restored fixture per turn.

## Part 2 evidence — live root probes (28 Oct, :4100, pid 4147755)
- PATCH /session/:id {"tools":["read","session"]} → HTTP 200, response
  "tools": null — silently ignored (patch_session only handles title).
- GET /session/:id → keys: id, parentID, state, time, title. No tools field.
- POST /session/:id {"tools":[...]} (no parts) → 405 (GET route registered,
  body shape wrong) — no tools concept on the message endpoint either.
- Code: Session struct = {info, messages, todo}; agent_loop always passes
  tools::schemas() upstream; YGG_TOOLS=0 is the only lever (global, all 8 off).
- opencode prior art (read-only, from installed SDK 1.18.30 types.gen.d.ts):
  AgentConfig.tools: {[toolName]: boolean} per agent + AgentConfig.permission:
  {edit|bash(patterns)|webfetch|doom_loop|external_directory: ask|allow|deny}
  — per-agent allowlist AND an enforcement layer. Also permission.external_directory
  live in the box's ~/.config/opencode/opencode.json with explicit deny/allow paths.

## Proposed root feature (feeds ROOT-CONTRACT): {session/tool-allowlist}
Scope: S (small). API shape:
- POST /session  {title?, parentID?, tools?: ["read","bash",...]}  — default = all 8
- PATCH /session/:id {tools: [...]} — same semantics; validate names, 400 unknown
- GET /session/:id → info.tools echoed
- agent_loop: filter schemas() by session allowlist before relay; run_tool:
  reject non-allowlisted calls with ok:false "tool not allowed in this session"
  (defense in depth: the model can still hallucinate a call).
Env alternative considered (YGG_DEFAULT_TOOLS + per-session override) — rejected
as the only mechanism: env is process-wide and the phone/PWA cannot set it per
session; the body/PATCH shape is what a client needs. Env default is fine as a
bonus (YGG_DEFAULT_TOOLS=read,glob,grep,bash).
Naming nuance for the verdict: "session" tools (create/list/message sub-sessions)
are NOT first-class tools in yggdrasil today — MAIN does session management via
bash+curl. A B/C-style allowlist {read, glob, grep} without bash is only honest
if MAIN gets real session tools (tools.rs) or keeps bash and accepts the porosity.

## Driver ops notes (for reproducibility)
- boot.sh: kills stale port-holder first (ss+grep pipeline needs `|| true` under
  set -e), health check now verifies the new pid is alive before curl succeeds.
- upstream.key: bare key only (the first attempt stored KEY=... whole-line —
  produced silent 401s; z.ai rejects with {"type":"1000"}).
- fixture .git removed: git object files are read-only and broke shutil.copy.

# Anthropic subscription lock-in — verified facts (10-03)

Why Claude Opus works with a subscription in Claude Code but not in opencode.
Checked against opencode **1.18.30** source (anomalyco/opencode, dev branch) and models.dev.

## The facts

1. **Anthropic allows subscription auth (Claude Pro/Max OAuth) only in first-party clients.**
   Claude Code is Anthropic's own tool; the OAuth client IDs are Anthropic-controlled and
   their servers validate the client. The ToS explicitly prohibits third-party tools from
   using subscription auth. This is a deliberate lock, enforced by policy AND server-side
   client validation.

2. **opencode removed bundled Claude Pro/Max support in v1.3.0.**
   Docs (providers page, Anthropic section) state: plugins enabling Claude Pro/Max in
   opencode are "explicitly prohibited" by Anthropic; bundled plugins dropped as of 1.3.0.
   Source check of 1.18.30 confirms:
   - `packages/opencode/src/plugin/` ships auth plugins for openai/codex, github-copilot,
     azure, xai, cerebras, cloudflare, digitalocean, modal, snowflake — **no anthropic**.
   - The only "Claude Pro/Max" strings in the repo are docs/i18n text, not auth code.
   - models.dev `anthropic` entry carries no OAuth/auth metadata → `/connect` → Anthropic
     offers API-key entry only.

3. **Community OAuth bypass plugins exist but violate ToS** → real risk of account
   suspension. Not a path bifrost/veraldar should rely on.

4. **The contrast is a choice, not a technical gap**: OpenAI (ChatGPT Plus), GitHub
   Copilot and GitLab Duo allow their subscriptions in third-party tools — all work
   natively in opencode. Anthropic chose exclusivity.

5. **Z.AI GLM Coding Plan** (our current plan): works in Claude Code (via
   `ANTHROPIC_BASE_URL` redirect to Z.AI's Anthropic-compatible endpoint) AND natively in
   opencode (`/connect` → Z.AI → **Z.AI Coding Plan**). It serves GLM models only —
   Claude models are never available through it.

## Practical consequence

- Opus + subscription → **Claude Code only**.
- Opus in opencode → pay-as-you-go Anthropic API key, or a cloud gateway (Bedrock/Vertex).

## Standing decision (10-03)

No multi-agent harness layer under bifrost for this. Mitigation is already available:
an opencode session can shell out to Claude Code when subscription Opus is needed
(delegate pattern). Lock noted; revisit trigger below.

**Revisit if**: Anthropic tightens further (API-based third-party usage curtailed,
aggressive pricing/lock pressure), or multi-model orchestration needs grow beyond
"occasionally ask Claude Code" — then a thin harness/dispatch layer under bifrost
becomes worth building.

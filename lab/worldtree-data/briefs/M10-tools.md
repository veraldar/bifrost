# M10 brief — tool co-evolution: the variable the tree under-weights

Worker for [LAB] worldtree-data. The USER'S REFLECTION, verbatim (this IS the requirement — your design must answer it, not paraphrase it away):

> "I don't think the tree takes into account enough the limitation of AI **by its tools**. If it has the simulation to experiment and evolve competitions, it can resolve basically anything — math, physics, finance, cryptography… The tree doesn't represent enough the **evolution of tools vs models**. Humans evolved with their tools, so is AI. Now **anyone is building new tools for AI**, which will unlock real model potential that we haven't discovered yet. We evolved with our environment and the tools we created; LLMs are beyond their tools and are creating them faster than ever and evolving at the same time faster than ever."

Translation into the data system: the tree measures models (capability) and world states, but under-measures the TOOL ECOSYSTEM co-evolving with models — the unlock variable. Your job: measure it, wire it, and give it space on the page.

## What to build (AGI judgment inside these rails)

### 1. Tool-ecosystem indicators (collection)
Candidates — judge, pick the best measurable set, all keyless + inside the existing GitHub budgets (60/hr core, 10/min search — see wt/fetch.py github patterns):
- **Tool creation by the many** (the user's core claim): GitHub search counts of repos CREATED per month by topic — `topic:mcp`, `topic:ai-agents`, `topic:llm`, `topic:ai-tools` (created:YYYY-MM-01..end) → monthly counts accumulating (the commits_month pattern, search API, 1 req per topic-month). This literally counts "anyone building new tools for AI".
- **MCP ecosystem**: the modelcontextprotocol/servers repo (stars + releases) and/or registry size if a keyless endpoint exists (probe; else the repo series covers it).
- **AI-solves-math proxy**: Lean mathlib (leanprover-community/mathlib4) commit velocity + releases — formal math is where "AI can resolve basically anything (math…)" is already measurable.
- **Tool-use benchmarks**: release cadence of function-calling/agent benchmarks you can find (berkeley-function-calling-leaderboard, tau-bench etc.) — or fold into the release series set.
- **Agentic frameworks**: star snapshots for a small set (langchain-ai/langchain, run-llama/llama_index, crewAIInc/crewAI, microsoft/autogen, openai/swarm… ) — rides the existing stars pattern.
Provenance identical: sidecars, sha256, budgets respected, accumulating-monthly where history is unobtainable (disclose the ramp like M6 did).

### 2. Prediction wiring
- New series → catalog + mapping rows: your judgment on realm + direction. The thesis says tools UNLOCK model potential → at minimum divergence (many small actors building) + transcendence (capability unlock); consider utopia if you wire a science/math tool signal (mathlib = AI attacking hard problems). Weights 1-2, rank_delta, same discipline. method bump + CHANGELOG + fixture refreeze; world weights WILL move — that is the point; let the numbers speak and report the move.
- gates/provisional rules unchanged.

### 3. Page (AI EVOLUTION tab gains the co-evolution view; brand frozen)
- The tab already shows model-side exponentials. Add a TOOLS block: "the tools are evolving too" — tool-repos-created-per-month curve (the anyone-is-building curve) + mathlib velocity, full-width chart grammar, provenance line (github-trends.json gains a `tools` block — extend wt + publish + schema, sha-chained as everything else).
- One in-grammar sentence in the tab's notes stating the thesis and how the data answers it (tools curve vs model curves on one tab), with the indicator list linked to /data/. Do NOT touch the OUTCOMES tab's frozen design beyond what the new series does to the numbers themselves.

### 4. Verify (end green)
- `bash tests/m10_tools.sh` (new): parse fixtures, budget guard, series-in-data-with-sidecars, exponential-or-growth evidence printed (tool-repo counts by month/year — report the actual curve), world mapping rows live, m3+m5+m6_github+m6_countries all green.
- Deploy via scripts/publish.sh; live checks; playwright screenshot of the AI EVOLUTION tab with the tools block → artifacts/worldtree-tools.png (use ~/Work/bifrost/pwa playwright; hash-route #evolution).

## Rules
Commit per step (pathspec: lab/worldtree-data + veraldar-site/world-tree.html + sw.js). Twice-failing step → BLOCKER-M10.md. Read briefs/M6-github.md + wt/fetch.py github implementation first — reuse its patterns, budget guard, and accumulating-month machinery. Territory: lab/worldtree-data + veraldar-site world-tree.html/sw.js + artifacts. If a probe 404s (registry endpoint, benchmark repo), drop it with a note — never fabricate.
End with: git log -5 (both repos), the tool-curve numbers (e.g. mcp-topic repos created 2024 vs 2026), which realms you wired and why, all greens' last lines, screenshot path.

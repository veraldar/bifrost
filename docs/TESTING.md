# Testing law — the three tiers (owner canon, 10-30)

1. **Unit test** — one function/module, deterministic, no network. Standard.
2. **Integration test** — real components wired together (root API + PWA route, service + store). Deterministic where possible. Standard.
3. **Simulation** — **LLM agents acting as users and engineers** inside a sandboxed but *real* stack: the app running, the trunk running, several routes running, many users — all of them LLMs — exercising the system through procedures, skills, and loops to validate it. Agents bring personas: cold visitor, layman friend, pushing user, engineer on call.

## Standing rules
- Briefs name the tier: every mission states which tier validates its work — "simulated" means tier 3, not unit/integration (past misuse of the word is corrected by this file).
- **Tier 3 is not required for every step forward.** It is required for: release gates, anything touching trust/security/pairing, cross-route behavior, and onboarding flows. It is *used* for: finding deeper bugs earlier, release confidence, regression nets.
- The simulation world is a product: one sandbox stack (app + trunk + routes) with N LLM personas driven by procedures. Reuse what exists: harness-bench (LLM task batteries), layman-deploy's fake friend, tool-policy's pushing user, the gate's dispatch probe.
- Sim failures are findings, not noise: they file themselves (lab row +, if product-affecting, a report).

Registered by MAIN from the owner's verbatim definition, 10-30.

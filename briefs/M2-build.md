# M2 brief — build pipeline v0

Worker for [LAB] worldtree-data. Coordinator spawned you to EXECUTE, not redesign.

## Execute
~/Work/bifrost/docs/worldtree/plan.md is your work order. Read it top to bottom and execute steps 0→11 in order, from ~/Work/lab/worldtree-data (repo R). The design docs (README/sources/schema/prediction.md, same dir) are the spec the plan references — read what each step points to.

## Rules (playbook, binding)
- Each step ends with its verify block green, then `git commit -m "M2 step N: ..."` in R. Commit per step, not in bulk.
- A step failing twice → STOP and write the blocker to ~/Work/lab/worldtree-data/BLOCKER-M2.md (what failed, exact error, what you need). Silence is never a state.
- Python stdlib only where plan says so. No paid/keyed anything. The four core sources are free; proofs first (step 1) before any code.
- Do not touch anything outside R (no bifrost, no veraldar-site*, no /var/www).
- AGI judgment: micro-choices inside a step are yours; never deviate from a verify's expected output.

## Done means
`bash tests/m2_green.sh` exits 0 printing `M2 GREEN`, out/realms.json is contract-valid, git log shows per-step commits, and PROV-OK provenance evidence exists.

## End your run with
- `git -C ~/Work/lab/worldtree-data log --oneline`
- last 5 lines of tests/m2_green.sh output
- one line: what the 7 weights are.

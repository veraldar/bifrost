# The Veraldar doctrine — how we run AGI across machines

Written 10-03 from the combined findings of two AGI organizations:
the omarchy product fleet (bifrost) and the Mac Studio fleet (Thor:
World Forge, Volharvest, ARI, the tournament). Same laws, two domains.

## The division
- **omarchy fleet**: the product — bifrost, yggdrasil, bifrost-net, the labs
- **Mac fleet (Thor)**: research, finance, simulation, world-data (ARI, World Forge, Volharvest)
- **Cross-pollination**: artifacts flow over the tailnet (proven: ARI report → worldtree; launch kit → PWA). Any fleet can feed any other.

## The laws (both fleets, non-negotiable)
1. **Goal, not blueprint** — AGI gets judgment under freedom; a plan from a
   weaker model is still a blueprint.
2. **Rebuild the life, not the surface** — study files, data, DB, logs;
   infer usage; build for the user's best interest, not the API's shape.
3. **Answer-first** — die on a question → propose the best answer, move on.
   Never stall silently. Blocked = visible.
4. **Active driver or death** — sessions prompted once and abandoned die.
   Drivers run on cadence; corpses get revived; 3 strikes escalate to human.
5. **Evidence or it didn't happen** — every milestone: the command, the
   output, the receipt. Fabricated claims are the cardinal sin.
6. **Detached execution** — anything >2s runs detached (setsid/tmux/systemd).
   In-process children die with the session. (Learned via triple-murder.)
7. **The model ladder** — Opus: judgment/builds. Sonnet 5.5: reviews, drafts,
   verification. GLM/flash: coordination, relay. Escalate only on
   insufficiency.
8. **The user is a gate** — intention echo always; coordinator holds
   checkpoints; the user approves, picks, stops. Direction is human.

## The cadence (proven tonight, Thor fleet)
19 delegations/night, 0 stalled: fire → verify per milestone → commit per
milestone → report one line. The driver sweeps; corpses revive; blockers
escalate. Budget windows plan around resets (heavy work inside the window,
cheap tiers after).

## The compounding
Every failure becomes a rule here. Every rule makes the next AGI generation
faster. The doctrine is the memory; the fleets are the hands.

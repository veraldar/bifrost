# How to use AGI — the Veraldar guide

Written for the one who drives. You never need perfect words — you need the
right SHAPE of ask. AGI fills in the rest; your job is direction, judgment,
and the final call. Everything below was learned by running this fleet.

## The division of labor (the user is a GATE, not a prompt engineer)

- **The user** states intention plainly — any words, any order. Then only
  gates: approve, reject, pick, say stop.
- **The coordinator** (main session) captures the intention, translates it
  into the right prompt shape, holds the checkpoint, verifies the outcome,
  and reports one-liners. ALWAYS — every mission, every size — the coordinator echoes the
  captured intention back in one line ("I understood: X, for Y — going")
  and proceeds unless corrected. The echo is never skipped.
- **AGI** gets freedom of judgment inside the goal — and carries the work.

The user is never asked to find the right words. Finding the right words is
the coordinator's job; gating the result is the user's.

## The model ladder (Opus + Sonnet 5.5)

Two AGIs, used for what each is best at:
- **Opus** — judgment, architecture, hard builds, security reasoning
- **Sonnet 5.5** — cheaper and faster: reviews of drafts, doc passes, verification reads, second opinions, research summaries

Rule: heavy thinking goes to Opus; everything that is *checking, drafting, or
reading* goes to Sonnet first. Escalate to Opus only when Sonnet's output is
insufficient. Both are AGI — the ladder is about cost and speed, not rank.

## The five shapes of asking

### 1. Build something new
Say the GOAL, the USER, and what DONE looks like. Never the blueprint.

> "Build [what] for [who]. It must [hard constraint]. Done means [verifiable
> thing]. Decide the rest yourself — show me your plan before building."

Why: blueprints turn AGI into an instruction-follower. Goals turn it into a
designer. The plan-before-build step is where you catch wrong thinking cheap.

### 2. Rebuild or clone something that exists
> "Rebuild the life, not the surface. Study its data, files, DB, and logs;
> reconstruct how it was actually used over days, weeks, months. Infer what
> I needed but never had to ask for. Where it falls short of my interest,
> build the better version. Show me your usage model before building."

This is Rule 10-02 (docs/lab-playbook.md). The time dimension is mandatory:
compaction-type features only reveal themselves over weeks of use.

### 3. Fix a bug
> "[Symptom]. [What I did]. [What happened vs what should happen]. Reproduce
> it first, show me you reproduced it, then fix and prove the fix."

Never accept a fix without a reproduced bug — that is how phantom fixes
happen.

### 4. Research
> "Question. Sources. Deliverable: [file/artifact] with [format]. Mark
> anything you could not verify as TO-VERIFY."

### 5. Review or second opinion
> "Read [files]. Critique: sequencing, gaps, security, blind spots. Where
> you disagree with [other reviewer], say so. Ranked findings."

Run TWO different models on big decisions and compare — agreement = high
confidence, divergence = your judgment is needed there.

## The six laws (for every ask)

1. **Goal, not blueprint.** Freedom is the measurement; blueprints are the ceiling.
2. **Done must be verifiable.** "Working", "better", "robust" are not done.
   A command, a number, a test.
3. **One checkpoint before the build — held by the coordinator.** "Show me
   your plan/usage model" — the cheapest place to catch wrong thinking. The
   USER never reviews this checkpoint: the main session reviews it on their
   behalf, against their intentions.
4. **Blocked = visible.** A session that needs you must ask, loudly. Silence
   is a failure state, not patience.
5. **Active driver.** Check in every turn. A lab prompted once and abandoned
   will stall — that is proven, not theoretical.
6. **Honest assessment required.** Every finished ask includes "what I
   could not do, and why." No assessment = not done.

## The Fleet pattern (many sessions, one of you)

- Main session = coordinator: it routes, tracks, and reports one-liners.
- Off-topic thought → forwarded verbatim to the owning session.
- Big builds → own branch/worktree, own session, playbook rules.
- You only ever answer: decisions, accounts, taste, and go/no-go.

## What only you can do (the irreducible human)

- Want things (direction)
- Judge feel (is it good?)
- Carry consequences (name, money, law)
- Say stop (good enough = ship)

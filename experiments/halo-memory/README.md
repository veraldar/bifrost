# halo-memory: validating the "weights as long-term memory" approach

**Question:** can a continuously-trained LM over a session ledger provide *associative recall* that exact retrieval (grep/BM25/RAG) cannot — without forgetting?

## What is being tested

| # | Hypothesis | How it's measured |
|---|---|---|
| H1 | Continual training on a growing ledger retains old knowledge | held-out loss on old topics, before vs after reading new topics (massed vs interleaved vs frozen-core arms — replicating mini-AGI's slow-trunk finding at toy scale) |
| H2 | The halo (primed LM) surfaces associations exact retrieval misses | primed with a probe session, model must rank the *target* past session above decoys — where probe and target share **no surface vocabulary** (alias/paraphrase association) |
| H3 | halo + grep beats grep alone | combined ranking vs baseline rankings, split by bridged/unbridged concepts |
| H4 | Hallucination cost is bounded | hit rate on decoys (false positives), base rate given by construction |

## Corpus design (gen_corpus.py)

Synthetic session ledger, seeded and fully controlled ground truth:
- 8 topics, 6 "old" + 2 "new" (for the retention arms), ~6,400 sessions, ~430K chars
- **80 planted concepts**: an early "target" session (decision about alias A: *"decided the plot loop should use firmware instead of the old path"*) and a late "probe" session about the same referent under **alias B** (*"the elo job cut-off again right before the bewildering"*) — zero shared content words, only the topic name
- 40% of concepts also get **bridge** sessions (explicit "migrated X onto Y" notes) — retrieval *should* solve these; the halo's real test is the 60% **unbridged**, where the association exists only through noisy co-mention sessions
- 9 same-topic decoy targets per probe → chance hit@1 = 0.10

## Baselines (baselines.py)

grep, BM25, and 1-hop grep (query expansion via co-occurring tokens). Current results (seed 7):

```
all:        grep hit@1=.062  bm25 .062  grep1hop .075   (chance .10)
unbridged:  grep hit@1=.038  bm25 .058  grep1hop .077
```

Exact retrieval fails on this task **by construction** — it has no mechanism to link alias A to alias B. That is the gap the halo must fill; the experiment has headroom to detect a real effect.

## Model (train_halo.py)

~2.6M-param char-level transformer (4 layers, d=128, ctx=256) — toy scale, but the hypotheses are architectural, not scale-bound. Protocol:

1. **Base**: train on old-topic stream (2,500 steps)
2. **Arms** (from the same base checkpoint):
   - `massed`: read only new topics → old knowledge should degrade
   - `interleaved`: new + ~10% old mixed → should retain (mini-AGI's finding)
   - `frozen`: new only, embeddings+attention frozen → slow-trunk analog
3. **Eval per arm**: old held-out loss (H1), association ranking (H2/H3), decoy false-positive rate (H4)

## Reading the results

- If `interleaved` retains old loss AND association hit@1 climbs clearly above 0.10 → halo adds real associative recall at toy scale → worth scaling up (real mini-AGI needs CUDA)
- If retention holds but association stays at chance → the halo remembers *domains* but can't link *referents* at this scale → negative for memory use, interesting for science
- If association works but decoy false-positives are high → halo as *hints-only* (never as facts), matching the halo+ledger design

## Run it

```bash
uv venv .venv --python 3.14
uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu numpy
python3 gen_corpus.py --seed 7 && python3 baselines.py
.venv/bin/python train_halo.py --seed 0 --out results/results_s0.json
```

## What this does NOT test

- Scale effects (2.6M params vs mini-AGI's 559M) — a pass here justifies renting a GPU for the real thing, not the real thing itself
- Deletion/auditability — architecturally absent from weights-based memory, assumed
- Real session logs — synthetic templates are cleaner than reality; a second pass should replay actual bifrost session exports

# URD — THE TEST LEDGER

What happened. Every gate test gets a row: what, when, version, result,
evidence. Urd remembers.

Schema: `| date | version | test | result | evidence |`

---

## Historical (backfilled from the journey)

| date | version | test | result | evidence |
|---|---|---|---|---|
| 10-01 | v0.6.0 | brand rebuild smoke (live :8080, phone) | PASS | git `d9c5671`, release notes |
| 10-02 | v0.6.1 | hotfix deploy + probe | PASS | git tag, deploy log |
| 10-03 | — | bifrost-net M1 (mesh+rekey+relay+serve) | PASS 5/5 | `e13efec`, lab report |
| 10-04 | — | voice duel: Qwen3-ASR vs Parakeet Redux (WER/RTF) | PASS — Parakeet earns edge tier | lab report, WER tables |
| 10-04 | v0.6.x | female voice live (af_heart F0 235Hz) | PASS | session transcript, F0 measurement |
| 10-05 | v0.7.0 | fleet-sync tag | TAGGED | git tag `4ad15cc` |

---

## Open tests

| date | version | test | result | evidence |
|---|---|---|---|---|
| 10-06 | v0.7 | **the first conversation with the root** — sandbox :8443, the rust PWA + yggdrasil :4100 | **FAIL** (user verdict): onboarding slow to load + slow tree click; greeting voice slow to start (prerecord?); **STT dead** — spoke, no voice-to-text; post-onboarding flow unclear. 3 dispatches: onboarding-flow, voice-stt-sandbox, sim-gap | user voice report, this ledger |

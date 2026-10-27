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

| 10-06 | v0.7 | live brain down -> user's [MAIN] session served by the ROOT on :8443 | **PASS (by accident)** — the consent evolution proven: the stacks are independent, the fallback works | the user's report, the root's session list |

| 10-06 | v0.7 | sandbox voice gate (the user, directly with the root on :8443) | **PASS** — STT 3-for-3, "Bifrost" clean; found: hotword attack-drop + echo bleed (queued); ONBOARD-BUILD running | the root's [MAIN] session, 92 msgs |

## Open tests

| date | version | test | result | evidence |
|---|---|---|---|---|
| 10-06 | v0.7 | **the first conversation with the root** — sandbox :8443, the rust PWA + yggdrasil :4100 | **FAIL** (user verdict): onboarding slow to load + slow tree click; greeting voice slow to start (prerecord?); **STT dead** — spoke, no voice-to-text; post-onboarding flow unclear. 3 dispatches: onboarding-flow, voice-stt-sandbox, sim-gap | user voice report, this ledger |
| 10-19 | v0.7 | **the STT leg of the v0.7 FAIL — phone-class repro, RED→GREEN** (reproduce-first law): the repro (mobile UA on :8443, cold start, tree-door → MAIN → hold mic → real-speech wav as the browser mic) **RED** under the bug (STT_MODEL=faster-whisper-small → Mac 500 ModelDimensions: 150 s of talk, zero transcripts) → **GREEN** on the fix (Qwen3-ASR): transcript lands in MAIN ("…Bridge voice test."), no lab-wav leak; endpoint A/B: 500 vs exact transcription. Client leg (10-14 labmic hijack) verified DEAD on the served build: flag off at build (even ?labmic=1 passes the device mic through). | PASS — **user mic retest still open** | repro spec `bifrost-sandbox/pwa/e2e/stt-phone.spec.ts` + `playwright.stt.config.ts`, receipt `artifacts/stt-repro-receipt.md`, shot `artifacts/stt-repro-green.png`, root-cause report `artifacts/stt-dead-v07-report.md` (stt2) |

## THE PROMOTION (10-27 night)
| 10-27 | v0.7.0-rc2 | consent check (user, 9 taps on :8443) | **PASS — "all good"** + note: the flash main over-thinks, under-delegates (S7 concierge evidence) | the user's words, this ledger |
| 10-27 | v0.7.0-rc2 | promote: backup(29/29 restore) → switch(GATE GREEN 21p) → rollback rehearsal BACK+FORTH(GREEN×2) | **LIVE — v0.7.0-rc2 on :443, v0.6.1 = PREVIOUS** | promote.sh --list, the gate lines |

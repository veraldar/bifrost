# INCIDENTS — the incident-to-scenario pipeline register

Every production incident becomes a scenario in the next version (co-evolution
law). This register is the feed: one line per incident, mined each cycle from
diag/claims/journal evidence. The cycle command cross-checks coverage against
the scenario registry and FAILS when an incident stays uncovered for more than
one version cycle (`since` = the cycle it entered the register).

Line shape (parseable):
`- [id] date — symptom (source) | covered-by: <scenario-name-fragment|none> | class: <class> | since: <cycle>`

- [agent-dup] 10-02 — duplicate-agent race: a refresh re-dispatches while the old agent drains; room agentless ~30s, every hold/tap fails (claims: agent-dup, live 10-02 room review) | covered-by: none | class: agent-worker | since: 7
- [chunk-race] 10-04 — ChunkLoadError build race: clients load chunks while a deploy swaps them (the rebuild lane's deploy gate) (journal/rebuild lane) | covered-by: none | class: pwa-build-race | since: 7
- [tts-stutter] 10-03 — second concurrent TTS request resets the in-flight Mac speech stream → stutter (claims: stutter-fix, repro 4-parallel → 3 reset) | covered-by: none | class: concurrent-tts | since: 7
- [oc-timeout] 10-05 — 300s undici headersTimeout killed every >5min run mid-flight → "no reply" (claims: oc-timeout, three ~300.8s runs in diag) | covered-by: none | class: long-run | since: 7
- [zai-429] 10-02 — zai 429 balance/rate rejections surface as run errors; session must survive (mock_upstream contract mock-429) | covered-by: rest.upstream-down | class: upstream-failure | since: 7
- [send-lost] 09-30 — message-arrival reaping: the send path could lose a message; fix = REST always lands the transcript (claims: send-lost) | covered-by: rest.refresh-reread | class: message-persistence | since: 7
- [sse-wedge] 09-30 — SSE liveness wedge: "no reply — run seemed stuck" (claims: wedge-fix) | covered-by: rest.abort-mid-run | class: run-liveness | since: 7
- [hf-restore] 10-02 — hands-free auto-restore made the first tap an EXIT ("single click at open is a trap", diag 10-02) (claims: open-restore) | covered-by: bridge.mode-switch | class: mode-restore | since: 7
- [ptt-arm] 09-29 — 250ms PTT arm vs 250-400ms human taps: hands-free never toggled (claims: tap-threshold) | covered-by: bridge.mode-switch | class: ptt-threshold | since: 7

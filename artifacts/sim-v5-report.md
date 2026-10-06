# ygg-sim v5 — the app lands, the mic question answered

Cycle 6 is **VALID**: 30 scenarios, 23 pass, 4 break as documented, 3 known
issues, 0 skip, **0 FAIL**. Sim 0.5.0 is paired with app 0.6.0.

## 1. "No mic in Chrome Android when the URL has a port"

**Not on Android Chrome.** Tested on Chrome 133 / Android 16 (emulator, real
permission prompt, virtual mic):

| origin | secure context | `navigator.mediaDevices` | mic (getUserMedia) |
|---|---|---|---|
| A `https://<tailnet-host>/` (443) | yes | object | **live track** |
| B `https://<tailnet-host>:8443/` | yes | object | **live track**. Prompt: "<host>:8443 wants to use your microphone" |
| C `http://<non-loopback IP>:<port>/` | **no** | **undefined** | impossible, no prompt at all |
| D `http://localhost:<port>/` | yes | object | live track |

![Chrome Android asking for the mic on :8443](/api/artifact/sim-v5-chrome-8443-prompt.png)

![plain http: Not secure, no mic API](/api/artifact/sim-v5-chrome-http-lan.png)

What breaks the mic is **plain http**, not the port. Two things could
explain what you saw on the phone:
- **Permissions are per origin, and the port is part of the origin.**
  Allowing :443 does not allow :8443 (B started at "ask" after A was
  granted). A "Never allow" you once tapped on :8443 stays until you
  reset it: on the phone, open :8443 → tap the icon left of the address →
  Permissions → Microphone.
- **The address bar hides `:8443`** on a narrow screen. You may have been
  on the http/LAN address without noticing.

An emulator cannot prove these on your phone: the real mic, Samsung's
battery rules, your saved site permissions, Android's mic privacy toggle,
or your Chrome version. The same probe can run on the S22 over adb (v6).

## 2. The Android app (wrap APK)

`pwa/android` is a 21 KB WebView shell, built on this box without root and
without Gradle. It loads the PWA, holds the mic permission, pairs via a
`bifrost://pair` link (the token is checked against the real bridge), and
can post notifications. The 4 app scenarios are live now:
- install + pair: **PASS**. Wrong tokens are refused.
- update by restarting the app: **PASS** (1.7 s).
- push: **break, documented**. WebView has no Web Push, so remote push needs
  FCM later. Local notifications work.
- screen off: **break, documented**. Android silences the app's mic about
  1 s after screen-off, and the page cannot tell. The fix is a microphone
  foreground service, the first native piece of v0.8. A design note covers
  it plus the native bifrost-net client.

## 3. Sim upgrades

- **Tool loop over the bridge**: works, but two tools running at once freeze
  every other bridge command for the tool's duration (ping 0.15 s → 4.3 s).
  The fix belongs in bifrost-net.
- **SLO budgets**: a scenario is green only within its time budget. 44/45
  budgets held (the miss is the known run.done bug). Voice turns are
  13–18 s against a proposed 8–10 s target, on CPU speech.

## 4. Speech-to-text in-process (your v0.6.2 decision)

Same phone audio. Model inside the voice process vs the speaches service:

| | in-process (Parakeet) | speaches service |
|---|---|---|
| English WER | **0%** | 0% |
| per short utterance | **≈0.5 s** | ≈5 s |
| 10 s utterance | **1.3 s** (gate ≤ 2 s ✓) | 6.2 s |
| French WER | 37% ✗ (multilingual v3 int8: 31%) | 18% |

English is ready and 10× faster. French needs a better in-process model
before the v0.6.2 gate passes.

## Next (v6)
1. Run the same probes on your S22.
2. Mic foreground service in the app.
3. More French test audio plus model candidates.
4. Track the bridge fixes.

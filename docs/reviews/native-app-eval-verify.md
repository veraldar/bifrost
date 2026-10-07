# native-app-eval — verification read (NATIVE-EVAL-CHECK, Sonnet rung, 10-04)

Scope: locally checkable claims only. Store = `~/.local/share/opencode/opencode.db` (read-only; ids are prefixes of the full `ses_…` ids).

| claim | doc says | verdict | evidence |
|---|---|---|---|
| ses_f2d393db "Need browser notification when thinking done" | req table | VERIFIED (paraphrase) | Session has "Browser notification when thinking done / it's your turn…" (assistant restating the ask). Same intent. |
| ses_f2aef95d "never receive notifications" | req table | VERIFIED | User text: "never receive notifications and session on the session list should show…" |
| ses_f0f5bbcd Tesla | req table | VERIFIED | User: "…back to hands free and see with … Tesla…" |
| ses_f2bc5115 mic not used by browser | req table | VERIFIED | "…microphone should not be used anymore by browser" |
| ses_f11f5692 "turn it off when I leave" | req table | VERIFIED | "…turn it off when I leave the push to talk" |
| ses_f1bb7a0c "mic muted as long as [playback]" | req table | VERIFIED (intent) | Same session: "the mic must stay muted through synthesis and playback." Exact wording differs. |
| ses_f125944a "mic came back while the agent was working" | req table | VERIFIED | Verbatim in user text. |
| ses_f16d4ccd noisy room | req table | VERIFIED | "There's some people around me speaking too." |
| ses_f28e2fdf install on android/ios, push a btn | req table | VERIFIED | "pwa app people can install on android / ios so they push a btn and everything is set up…" |
| ses_f28e2fdf "3. android app one btn ready" | req table | VERIFIED | "3. android app one btn ready. am I correct?" |
| ses_f28e2fdf girlfriend / iPhone / auto setup | req table | VERIFIED | "My girlfriend picks rather to an iPhone … the phone with the auto setup…" |
| ses_f28e2fdf "would a native android/ios app help" | intro | VERIFIED | Verbatim. |
| "178 sessions" | req heading | UNCHECKABLE-LOCAL | Store now has 219 sessions (213 created before today noon). Count was probably as-of an earlier snapshot, so it's stale, not wrong. Cosmetic. |
| push.ts:66 sends `{ TTL: 3600 }`, no urgency | field data | VERIFIED | `pwa/lib/push.ts:66` `webpush.sendNotification(s, payload, { TTL: 3600 })`. No `urgency` anywhere in the call. |
| 18 `ctx state → suspended` events | field data | VERIFIED-WITH-CAVEAT | 18 raw lines, all in `diag-2026-09-27.log`. Only 13 are unique after dedupe (the same line is logged once per open tab/route). Direction holds; "18" is raw. |
| 7 `push TimeoutError` | field data | FALSE (count + label) | 8 raw lines match, only 2 unique timestamps (2026-09-25 14:51:04 and one other). All are client `net-fail … GET /api/push TimeoutError: signal timed out` (a 10s fetch of the push endpoint). None are push-send or delivery failures. It can't be cited as push-delivery evidence. |
| zero iPhone UAs | field data | VERIFIED | `grep -i iphone\|ipad` over `pwa/.diag/*` → 0. UAs are `Android 10; K` (5415 lines) plus `Android 14; sdk_gphone64` emulator (26). |
| plan.md merged v0.8 into one v0.9.0, "no separate v0.8 release" | ladder note | VERIFIED | `docs/plan.md:50`: "v0.9.0 (USER: v0.8+v0.9 compressed — one arc, one release…) … no separate v0.8 release". |
| S1 device tokens are part of v0.9.0 | ladder note / compliance | VERIFIED | Same row: "device tokens (S1 full semantics) … tokens built FIRST inside the arc"; matches commit 9c0425e. |

## Gaps (TO-VERIFY items that are locally checkable)

- **Android screen-off mic** — the doc defers it to a "probe in android-lab". It is checkable locally, but I did not run it (read-only mission). Verdict: still open, correctly labeled.
- **Wake Lock in installed iOS web apps** — no iPhone available, so it is genuinely UNCHECKABLE-LOCAL.
- **`/pair` + bearer middleware** — S1 compliance claims "same middleware, no native-only endpoint". Commit 9c0425e and `pwa/app/pair/` exist in the working tree. I did not audit the middleware, so this is unverified here.
- **"wave 3"** (Rung B trigger) — I didn't find a definition in the doc. Check that it is defined in plan.md.

## Doc consistency

No contradictions found. Verdict (PWA-only to v1.0) matches the rungs. Rung A is gated on "v0.9.0 tagged" and Rung B on the layman ledger or ≥~10 asks. The "Never" line and locked-decision section (S1 seam, ladder untouched, evidence triggers) agree with each other. The v0.8→v0.9.0 relabel is disclosed up front.

## Flagged (judgment, not overruling)

1. The push-reliability trigger in Rung A ("delivery ratio <95%") rests on instrumentation that doesn't exist yet. The "7 TimeoutErrors" cited as supporting evidence are actually unrelated GET timeouts (see FALSE row). Fix the citation; the judgment may still stand.
2. Rung A also fires on a RED android-lab probe, which tests an emulator, not the S22. That could trigger a native build on a signal the owner's real device never showed. Consider requiring the owner's `bvl` data as well.

PASS-WITH-NOTES

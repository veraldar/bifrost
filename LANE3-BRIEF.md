# LANE 3 — the tonight-test runbook (lambda-user validation)

Write `docs/runbook-lambda-test.md` in this worktree (docs-only commit).
Audience: the operator (one page, plain words, no jargon). The test: the
user's girlfriend opens the product on her iPhone tonight and talks to it
hands-free; the user also validates hands-free on his own device.

Ground truth you write against (do not invent):
- The box: omarchy box, services are systemd USER units (lk-pwa on :8080,
  lk-agent, yggdrasil on :4100 = the brain, bifrost-net bridge for pairing).
- Pairing: the operator opens the box console /pair page (LAN URL of the
  box, e.g. http://<box-lan-ip>:8080/pair — discover the actual LAN IP with
  `ip -4 addr` and write the real address into the runbook), a QR renders;
  the girlfriend's iPhone (same Wi-Fi) scans it with the Camera app → opens
  the URL → one-time code redeemed → device minted → she lands on MAIN.
- After pairing: tap the mic once = hands-free on; she SPEAKS a question;
  the reply is SPOKEN back (voice via the existing LiveKit + speaches
  stack; the brain is yggdrasil → zai). Second tap ends hands-free. Text
  input works too (keyboard mode).
- Failure paths, each with the one-line fix: QR already used → generate a
  new one; "region" rejection → she is on a different network (use the
  home Wi-Fi); no reply → check `journalctl --user -u lk-agent -n 20` and
  `journalctl --user -u yggdrasil -n 20`; device lost → operator re-pairs
  from /pair; panic → kill-switch on the box console /devices severs
  everything, re-pair from scratch.
- A 5-line "what good looks like" acceptance list for the operator to tick
  during the test.

Read docs/spec-pairing.md first for the exact semantics (one-time codes,
region binding, HttpOnly cookies) so the runbook never contradicts the
contract. Where the runbook depends on deployment state that does not
exist yet (bridge unit name, env flags), write it against THIS contract:
`systemctl --user status bifrost-bridge`, `BIFROST_AUTH=tailnet` with
pairing endpoints live — and mark those lines [VERIFY AT DEPLOY].

Commit: `docs: lambda-test runbook — tonight's pairing + hands-free validation`.
Then exit. ~20 min.

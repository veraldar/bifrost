# YGGDRASIL — slice 4: package for Omarchy/Arch, deploy-ready for other people

Slices 1-3 are green: bifrost's own e2e suite drives yggdrasil via
OPENCODE_URL. Now make it installable by someone else on a clean machine in
one command. Deadline is real; land the deliverable green.

## Deliverables (all inside `install/`)

1. `install.sh` — one command, idempotent: builds (or reuses) the release
   binary, installs it, installs a systemd USER unit, an env template, and
   prints what to do next (how to set the upstream + how to point bifrost's
   OPENCODE_URL at it). Prefer a prebuilt binary sitting next to the script
   when present; fall back to `cargo build --release` (`source ~/.cargo/env`
   may be needed).
2. `yggdrasil.service` — systemd user unit (this is how bifrost itself runs;
   Omarchy/Arch convention). Read env from a config file. Hardened sanely
   (no new privileges; nothing exotic — it must still just work).
3. Env template (`.env` style) — the YGG_* vars, documented inline.
4. `README.md` — install, configure upstream, run, point bifrost at it
   (OPENCODE_URL), verify with one curl. Written for a stranger.
5. PKGBUILD (optional, if cheap after 1-4): Arch-native alternative that
   builds the same thing. Skip without guilt if time is short — 1-4 are the
   deliverable.

## Verification (your own, before you report done)

- Clean-path install: run install.sh with XDG_CONFIG_HOME / XDG_DATA_HOME /
  bin dir pointed at a throwaway prefix — files land exactly where a stranger
  would expect, nothing leaks into the real home except what install.sh
  explicitly says it touches.
- The INSTALLED unit actually runs under `systemctl --user` (you may need a
  daemon-reload on the real bus for the unit-start check — that is fine;
  document it) and serves a full curl round-trip: POST /session → POST
  message (mock upstream) → SSE reply → GET history.
- The install.sh re-run does not break anything (idempotency).
- Release binary: strip it, note its size.

## Judgment calls are yours

Prebuilt-in-git vs build-from-source default, unit hardening level, default
port (4096 is opencode's — colliding on purpose so OPENCODE_URL needs no edit
is a legitimate choice, but so is 4100 + one env line; pick and defend),
PKGBUILD or not. Write every call + reason into a slice-4 section of
ASSESSMENT.md.

## Operational facts

- `source ~/.cargo/env`. Work only in `lab/yggdrasil/`. Product code frozen.
- You have ~45 minutes. Blocked twice on the same thing: stop, write, exit.

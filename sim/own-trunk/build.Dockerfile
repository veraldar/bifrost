# Builds bifrost-net + yggdrasil for Debian 12 / Ubuntu 22.04+ (glibc ≤ 2.36), linked against the system libopus
# like the release binaries. Used by sim/own-trunk-e2e.sh; output goes to trunk/target-bookworm, root/target-bookworm.
FROM rust:1-bookworm
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libopus-dev pkg-config >/dev/null && rm -rf /var/lib/apt/lists/*

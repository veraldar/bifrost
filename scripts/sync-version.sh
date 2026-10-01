#!/usr/bin/env bash
# prebuild: make package.json version = the git tag the build comes from
# (settings page displays it — must never drift from the release, again)
set -e
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
V="$(git describe --tags --always 2>/dev/null | sed 's/^v//' | head -1)"
[ -z "$V" ] && exit 0
cd pwa && npm version --no-git-tag-version --allow-same-version "$V" >/dev/null

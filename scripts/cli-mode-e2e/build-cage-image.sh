#!/usr/bin/env bash
# Build a minimal OS-cage image OFFLINE from the host's static busybox — NO network pull.
# Used by the 034.5 isolation proof (and as the base for the gated real run). Idempotent.
set -euo pipefail
IMAGE="${1:-cage-probe:latest}"

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "cage image '$IMAGE' already present (no pull needed)"
  exit 0
fi

BB="$(command -v busybox || echo /bin/busybox)"
[ -x "$BB" ] || { echo "ERROR: no busybox on host — cannot build offline image"; exit 1; }
if ! file "$BB" | grep -qi "statically linked"; then
  echo "ERROR: busybox is not static — an offline image needs a static shell"; exit 1
fi

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin" "$ROOT/work" "$ROOT/tmp" "$ROOT/etc"
cp "$BB" "$ROOT/bin/busybox"
for a in sh cat ls echo env id printf test ln nc wget mkdir rm head grep; do ln -sf busybox "$ROOT/bin/$a"; done

# Import as a flat image with no layers from any registry (fully offline).
tar -C "$ROOT" -c . | docker import \
  --change 'ENV PATH=/bin' \
  --change 'WORKDIR /work' \
  - "$IMAGE" >/dev/null

echo "built OFFLINE cage image '$IMAGE' from static busybox (no network pull)"

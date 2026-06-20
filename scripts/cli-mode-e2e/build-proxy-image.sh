#!/usr/bin/env bash
# Build the static CONNECT-proxy image OFFLINE (STORY-034.5 Layer-1 hardening). No pull.
# Compiles anthropic-proxy.go CGO-free into a static binary and imports a FROM-scratch image.
set -euo pipefail
IMAGE="${1:-cage-proxy:latest}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "proxy image '$IMAGE' already present (no pull needed)"; exit 0
fi
command -v go >/dev/null 2>&1 || { echo "ERROR: go toolchain not found"; exit 1; }

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
( cd "$BUILD" && cp "$HERE/anthropic-proxy.go" main.go && cat > go.mod <<'MOD'
module anthropic-proxy

go 1.21
MOD
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w' -o proxy main.go )
file "$BUILD/proxy" | grep -qi "statically linked" || { echo "ERROR: proxy binary not static"; exit 1; }

ROOT="$(mktemp -d)"
trap 'rm -rf "$BUILD" "$ROOT"' EXIT
mkdir -p "$ROOT/etc"
cp "$BUILD/proxy" "$ROOT/proxy"
chmod 0755 "$ROOT/proxy"
# nsswitch/resolv handling: the pure-Go resolver reads /etc/resolv.conf (docker provides it).
printf 'nobody:x:65534:65534:nobody:/:/proxy\n' > "$ROOT/etc/passwd"

tar -C "$ROOT" -c . | docker import \
  --change 'ENTRYPOINT ["/proxy"]' \
  --change 'EXPOSE 8889' \
  - "$IMAGE" >/dev/null
echo "built OFFLINE static proxy image '$IMAGE' (CGO-free, FROM-scratch, no pull)"

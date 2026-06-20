#!/usr/bin/env bash
# Build a SELF-CONTAINED claude cage image OFFLINE (no network pull) — STORY-034.5 Stage 3a.
#
# claude 2.1.179 is a self-contained ELF (bundles its own runtime; needs only glibc), so the
# image copies ONLY: a static busybox (shell/tools), the claude binary, and claude's glibc
# deps (resolved via ldd). NOTHING from $HOME beyond the claude PROGRAM binary is included —
# no ~/.claude, ~/.config, ~/.npm, ~/.ssh, ~/.codex, .env. The running cage mounts ONLY the
# sandbox copy (/work); there are no host bind mounts, so secrets cannot be dragged in.
set -euo pipefail
IMAGE="${1:-cage-claude:latest}"
CLAUDE_BIN="${2:-/home/pollux/.local/share/claude/versions/2.1.179}"

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "claude cage image '$IMAGE' already present (no pull needed)"; exit 0
fi
[ -x "$CLAUDE_BIN" ] || { echo "ERROR: claude binary not found/executable: $CLAUDE_BIN"; exit 1; }
BB="$(command -v busybox || echo /bin/busybox)"
file "$BB" | grep -qi "statically linked" || { echo "ERROR: need static busybox"; exit 1; }

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT"/{bin,lib,lib64,opt/claude,work,tmp,etc}

# 1) static busybox shell + a few applets (claude's Bash tool / our probe use /bin/sh).
cp "$BB" "$ROOT/bin/busybox"
for a in sh bash cat ls env id printf test mkdir rm head grep ln true; do ln -sf busybox "$ROOT/bin/$a"; done

# 2) the claude PROGRAM binary (non-secret code).
cp "$CLAUDE_BIN" "$ROOT/opt/claude/claude"
chmod 0755 "$ROOT/opt/claude/claude"
ln -sf /opt/claude/claude "$ROOT/bin/claude"

# 3) claude's dynamic deps (glibc + interpreter), copied to their real paths — system libs only.
for lib in $(ldd "$CLAUDE_BIN" | grep -oE '/[^ ]+\.so[^ ]*'); do
  [ -e "$lib" ] || continue
  mkdir -p "$ROOT$(dirname "$lib")"
  cp -L "$lib" "$ROOT$lib"
done
# the ELF interpreter must resolve at its literal path.
INTERP="$(readelf -l "$CLAUDE_BIN" 2>/dev/null | grep -oE '/lib[^]]*ld-linux[^]]*' | head -1 || echo /lib64/ld-linux-x86-64.so.2)"
mkdir -p "$ROOT$(dirname "$INTERP")"; cp -L "$INTERP" "$ROOT$INTERP" 2>/dev/null || true

# 4) minimal /etc so getpwuid etc. resolve; NO secrets.
printf 'root:x:0:0:root:/work:/bin/sh\ncageuser:x:%s:%s:cage:/work:/bin/sh\n' "$(id -u)" "$(id -g)" > "$ROOT/etc/passwd"
printf 'root:x:0:\ncage:x:%s:\n' "$(id -g)" > "$ROOT/etc/group"

# 5) a minimal, NON-SECRET Claude Code config (onboarding complete) so headless -p runs.
#    NO token here — auth is the broker-injected CLAUDE_CODE_OAUTH_TOKEN env. The entrypoint
#    copies this into the writable HOME at run time (claude updates its own copy there).
mkdir -p "$ROOT/opt/claude-config"
printf '{"hasCompletedOnboarding":true,"firstStartTime":"2026-01-01T00:00:00.000Z","userID":"cage","lastOnboardingVersion":"2.1.179"}' > "$ROOT/opt/claude-config/.claude.json"

SIZE=$(du -sh "$ROOT" | awk '{print $1}')
tar -C "$ROOT" -c . | docker import \
  --change 'ENV PATH=/bin:/opt/claude' \
  --change 'ENV HOME=/work' \
  --change 'WORKDIR /work' \
  - "$IMAGE" >/dev/null
echo "built OFFLINE self-contained claude cage image '$IMAGE' ($SIZE, busybox+claude+glibc, no host mounts, no pull)"

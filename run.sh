#!/usr/bin/env bash
#
# run.sh — single entry point for running the GateLoop product.
#
#   ./run.sh <command>
#
# Commands:
#   setup        install dependencies (pnpm install)
#   test         full test ladder L0–L4a + spec-coverage report  (the main "validate everything")
#   test:fast    test ladder up to L3 (skip scenario layer)
#   typecheck    tsc -b (static/type check only)
#   ci           typecheck + full test ladder (what CI runs)
#   walk         walking-skeleton demo — one story end-to-end through the harness (no LLM)
#   web          start the web dashboard (Vite dev server, default http://localhost:5173)
#   api          start the API dev server (tsx)
#   desktop      launch the GateLoop Console desktop app (Tauri; auto-starts the api sidecar)
#   desktop:build  package the desktop app → .deb / .AppImage / .rpm
#   codex-login  bind a Codex (ChatGPT) account to this project  (opens your browser)
#   codex-status show the current Codex binding
#   help         show this help
#
# Notes:
#  - Node is invoked via `node --experimental-strip-types` (the repo runs .ts directly).
#  - Run from anywhere; the script cd's to its own directory first.
set -euo pipefail

cd "$(dirname "$0")"

NODE="node --experimental-strip-types"

have() { command -v "$1" >/dev/null 2>&1; }
need_pnpm() { have pnpm || { echo "✗ pnpm not found (install: npm i -g pnpm)"; exit 1; }; }

cmd="${1:-help}"
case "$cmd" in
  setup)
    need_pnpm
    pnpm install
    ;;
  test)
    $NODE scripts/test-all.ts
    ;;
  test:fast)
    $NODE scripts/test-all.ts --until=L3
    ;;
  typecheck)
    need_pnpm
    pnpm typecheck
    ;;
  ci)
    need_pnpm
    pnpm typecheck && $NODE scripts/test-all.ts
    ;;
  walk)
    $NODE scripts/walking-skeleton.ts
    ;;
  web)
    need_pnpm
    echo "→ web dashboard on http://localhost:5173  (Ctrl-C to stop)"
    pnpm --filter @gateloop/web dev
    ;;
  api)
    need_pnpm
    echo "→ API dev server (tsx)  (Ctrl-C to stop)"
    pnpm --filter @gateloop/api dev
    ;;
  desktop)
    need_pnpm
    echo "→ GateLoop Console desktop app (Tauri). The app auto-starts @gateloop/api (sidecar)."
    echo "  First run compiles a debug build (a few minutes); the native window then opens."
    pnpm --filter @gateloop/desktop dev
    ;;
  desktop:build)
    need_pnpm
    echo "→ Packaging the desktop app (.deb / .AppImage / .rpm) → apps/desktop/src-tauri/target/release/bundle"
    GATELOOP_REPO="$(pwd)" BUN_BIN="$(command -v bun || echo bun)" pnpm --filter @gateloop/desktop build
    ;;
  codex-login)
    $NODE scripts/codex-login.ts
    ;;
  codex-status)
    $NODE scripts/codex-login.ts status
    ;;
  help|-h|--help)
    # print the leading comment header (everything before the first non-comment line)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^#\{1\} \{0,1\}//; s/^#$//'
    ;;
  *)
    echo "unknown command: $cmd"
    echo "run './run.sh help' for the list."
    exit 2
    ;;
esac

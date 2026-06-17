# ADR-0009 — Default backend: Codex via ChatGPT subscription (OAuth)

## Status
Accepted

## Context
We want to run agents on Codex models billed to a ChatGPT subscription rather
than metered API keys, reusing the Codex CLI OAuth path (as OpenCode/OpenClaw
do), with third-party APIs as fallback.

## Decision
Add an `oauth` auth mode to the Model Provider Gateway and make the `codex`
provider the default (`configs/providers.yaml`, `configs/model_routing.yaml`).
Login uses the public Codex client id over PKCE at auth.openai.com; tokens are
stored in `~/.codex/auth.json`, managed and auto-refreshed by the Secret Broker,
and never enter agent context. `~/.codex/auth.json` is a protected path. The
browser sign-in is the human gate. DeepSeek / third-party API keys are the
routed fallback.

## Consequences
- The OAuth token works only against the Codex backend endpoint and needs a
  Codex-CLI-shaped request; running the Codex CLI as executor is the robust
  alternative.
- The token shares ChatGPT rate limits and is personal-use only (no commercial
  resale / multi-user). Sustained autonomous load will throttle, hence the paid
  fallback.

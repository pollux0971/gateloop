# Codex OAuth Login (ChatGPT subscription)

GateLoop can run agents on Codex models billed against a ChatGPT
Plus/Pro/Team subscription, using the same OAuth path the Codex CLI uses (and
that tools like OpenCode and OpenClaw reuse). This is the **default** backend;
DeepSeek / third-party API keys are the fallback.

## Terms — read first

This path is for **personal developer use**. The token shares rate limits with
the ChatGPT web app, and OpenAI does not permit using it for commercial API
resale or multi-user services. A multi-agent autonomous harness can run many
LLM calls per `/goal` iteration, so expect throttling under sustained load —
which is exactly why routing keeps a paid third-party fallback.

## The flow (mirrors Codex CLI / OpenCode)

```text
gateloop auth login
  1. start a local callback server on http://localhost:1455
  2. generate a PKCE pair (S256)
  3. open the browser to:
     https://auth.openai.com/oauth/authorize
       ?response_type=code
       &client_id=app_EMoamEEZ73f0CkXaXp7hrann      # public Codex CLI client
       &redirect_uri=http://localhost:1455/auth/callback
       &scope=openid profile email offline_access   # offline_access → refresh token
       &code_challenge=<S256>&code_challenge_method=S256&state=<state>
  4. user signs into their ChatGPT account
  5. OpenAI redirects to localhost:1455/auth/callback?code=...
  6. exchange the code at https://auth.openai.com/oauth/token (with code_verifier)
     → access token + refresh token + id token
  7. store at ~/.codex/auth.json (managed by the Secret Broker)
```

Inference then goes to `https://chatgpt.com/backend-api/codex/responses` with
the access token as a Bearer token.

### Two important facts

- **The token only works against the Codex endpoint.** Its JWT scopes are locked
  to the Codex client, so the same token is rejected by `api.openai.com`. The
  request must also resemble a Codex CLI request (Codex system prompt) for
  OpenAI's auth check to pass. The gateway's `codex` provider replicates this
  shape via a localhost proxy.
- **The robust alternative is the Codex CLI executor.** Because the CLI performs
  this login natively, running Codex CLI as the `/goal` executor (already wired
  via `.codex/prompts/goal.md` + `AGENTS.md`) is the least fragile way to use
  the subscription — no request-shape mimicry to maintain. Use the gateway
  `codex` provider when you want the harness's own agents on the subscription.

## Token lifecycle

- **Auto-refresh.** When the access token is within ~5 minutes of expiry, the
  broker refreshes it using the refresh token. No interruption.
- **Re-login.** When the refresh token dies, the broker triggers an interactive
  browser re-login (`relogin_on_expiry: true`).
- **Headless hosts.** Use the OAuth device-code flow, or SSH-forward port 1455,
  or bootstrap with `CODEX_AUTH_JSON` copied from a machine that logged in.
- **Account id** is read from the id-token JWT claims.

Other auth modes: `gateloop auth login --api-key` (paste an OpenAI key) and
`--with-access-token` (stdin), matching the Codex CLI flags.

## Security integration

- The OAuth tokens live in `~/.codex/auth.json`, which is a **protected path**:
  agents cannot read it (see `configs/policy.yaml`), and `CODEX_AUTH_JSON` /
  `CODEX_ACCESS_TOKEN` are in the redaction list. Tokens never enter agent
  context, logs, or traces.
- The interactive browser sign-in is the human-gate step for enabling this
  provider; routine refreshed calls afterward are not gated.
- This path authorizes the LLM backend only. It does not let an agent call
  external tool APIs — that stays behind the Permission Gateway.

A login/refresh skeleton is in `packages/codex-auth`; the gateway calls it via
`packages/model-gateway`.

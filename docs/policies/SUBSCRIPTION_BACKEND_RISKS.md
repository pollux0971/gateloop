# Subscription backends — risks, ToS, and the operator contract (EPIC-035 / ADR-020)

**One line:** the subscription path (Codex/ChatGPT) is an **optional, detachable, bring-your-own-
credential enhancement** the operator enables at their own risk. **The endorsed, distributable
product default is a metered API key** (standard OpenAI/Anthropic keys via the Secret Broker).

## Why this exists
GateLoop's core builder drives backends in-process behind the `ExternalAgentDriver` seam. There are
two credential tiers, sharply separated:

| | Metered API key — **CORE (default)** | Subscription — **OPTIONAL (this doc)** |
|---|---|---|
| Auth | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` via Secret Broker | Codex/ChatGPT OAuth (PKCE), broker-stored |
| Endpoint | official, documented (`api.openai.com`, …) | `chatgpt.com/backend-api/codex/...` (undocumented) |
| ToS | officially supported, no risk, shippable | **grey area — see below** |
| Coupling | the core path | **detachable plugin — core must not depend on it** |

## The risks (read before enabling)
1. **ToS-grey / unofficial.** The subscription login reuses a Codex OAuth **client_id** (ported from
   opencode, MIT). This is **not an officially sanctioned third-party integration**. OpenAI may
   change, rate-limit, or **block** it at any time, without notice.
2. **Undocumented endpoint.** `chatgpt.com/backend-api/codex/responses` is internal and can change
   shape (it already requires non-standard `instructions` + `store:false` request fields). The
   harness tracks these, but breakage is the operator's to absorb.
3. **Bring-your-own-credential, own-the-risk.** The operator supplies their own ChatGPT subscription
   and accepts any account/billing/ToS consequences. GateLoop does not ship or proxy credentials.
4. **Claude/Anthropic subscription is NOT available.** The Agent-SDK ToS forbids claude.ai login for
   third-party products, and no working Claude subscription OAuth exists here. Use a metered
   Anthropic key if you need Claude.

## What's guaranteed regardless
- **Detachable:** the metered core (STORY-035.2–035.5) does **not** import the subscription plugin
  (`@gateloop/subscription-auth`). Removing the plugin, or its endpoint breaking, leaves the metered
  path fully working. Proven by `tests/subscription_detachable_035_6.test.ts` (0-importer scan +
  metered-runs-standalone).
- **Secret never touches the agent.** The OAuth token is stored at `~/.gateloop/codex-auth.json`
  (mode 0600), flows broker→fetch header only, and is never printed, logged, or placed in a trace.
- **One-time human login; only refresh is headless.** The agent/cage **never** self-provisions a
  credential. Login is an interactive host-side action; thereafter the refresh token renews access
  unattended.
- **A one-time ToS warning prints** whenever the subscription plugin is enabled (`warnSubscriptionToS`).

## One-time login (operator, host-side, interactive)
```bash
node --experimental-strip-types gateloop/scripts/gateloop-login-codex.ts
# → prints an authorize URL; open it in a browser on this machine, log in with your ChatGPT account.
# → the callback (localhost:1455) stores ~/.gateloop/codex-auth.json (mode 0600). The token is never printed.
```
Remote/SSH: forward port 1455 to your local browser. The credential auto-refreshes after; you only
re-login if the refresh token itself is revoked.

## Recommendation
Use the **metered API key** as the default for anything distributable or shared. Reach for the
subscription path only as a personal/internal convenience on your own subscription, fully aware of
the grey-area risk above.

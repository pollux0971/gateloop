# Security Model

## Security objective

Allow high developer autonomy inside disposable workspaces while preventing host compromise, secret leakage, and unauthorized stable modification.

## Trust boundaries

1. Agent text output is untrusted.
2. Tool requests are untrusted until evaluated.
3. Workspace files may be malicious.
4. Container outputs may include prompt injection.
5. Secrets must never enter model context.

## Enforcement layers

- Permission Gateway
- Workspace Manager
- Container Runtime
- Secret Broker
- Trace redaction
- Promotion Policy
- Validators

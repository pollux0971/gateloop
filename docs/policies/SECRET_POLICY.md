# Secret and Sudo Broker

## Rule

Agents must never receive raw secrets.

## Secret handles

Agents request handles such as:

```text
provider.openai.default
provider.anthropic.default
github.readonly.token
```

The Secret Broker injects secrets only into a child process environment after policy approval. Logs must be redacted.

## Sudo policy

Host sudo is not available to agents by default.

Allowed approaches in order:

1. rootless container
2. container-root inside isolated container
3. human-run setup script
4. extremely narrow sudoers allowlist
5. askpass wrapper only for allowlisted commands

Never store sudo passwords in repository files.

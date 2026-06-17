# Permission Policy

The Permission Gateway decides **allow / ask / deny** for every tool action
**before** it runs. It is the system's primary safety gate. It trusts the Story
Contract and the workspace registry — **never** the agent's or tool request's
self-report. Config: `configs/policy.yaml`. Model: `../architecture/03_TOOL_AND_PERMISSION_MODEL.md`.
Algorithm: `../architecture/12_RUNTIME_ALGORITHM_RULES.md` §4.

## Decision pipeline (ordered; first decisive step wins)
A tool request is never judged on a single flag. It passes through, in order:

```text
1. Resolve real cwd + target paths   → realpath() every path (follow symlinks)
2. Workspace registry lookup         → is the resolved cwd a harness-created
                                        disposable workspace? (NOT self-reported)
3. Symlink-escape check              → does any resolved path leave the workspace
                                        or point at a protected location?
4. Command risk parser               → tokenize the command; match danger classes
5. Protected-path detector           → secrets, credentials, VCS internals, stable/
6. Write-set detector                → is every write target ⊆ contract.allowed_write_set?
7. Mode rule                         → plan / ask / accept_edits / bypass_workspace /
                                        deny_unlisted
        ↓
   allow / ask / deny  (+ reasons)
```

## Hard rules (deny regardless of mode)
- Any path that, after `realpath`, lies **outside the disposable workspace** for a
  write/mutation, unless explicitly in the contract write-set.
- Reading any **credential/secret**: `.env`, `*.env`, `$HOME/.env`, `.ssh/`, `id_rsa`,
  `*.pem`, `*.key`, cloud cred files, browser profiles, `~/.codex/auth.json`.
- **Secret-exfil commands**: `printenv`, `env`, `set` (env dump), `cat`/`less`/`xxd` of
  a credential path, `python -c "import os; print(os.environ)"`, anything piping env to
  output or network.
- **Destructive commands**: `rm -rf /`, `rm -rf $HOME`/`~`, `find . -delete`, `mkfs`,
  `dd of=/dev/*`, `chmod -R 777 /` (or broad recursive perms), `shutdown`, `reboot`,
  `:(){ :|:& };:`.
- **Remote-exec / network-escalation**: `curl … | sh`, `wget … | sh`, `curl/wget -O- | bash`,
  package installs from arbitrary URLs, opening outbound network when the contract did
  not grant it.
- `sudo` / privilege escalation.

## Ask (escalate to human) rather than deny
When the action is legitimate at a boundary but needs approval: secret **use** via a
scoped handle, a granted network call, a `stable/` or protected-file change the contract
authorizes, container-profile changes, irreversible deletion inside the workspace.

## Mode rules
| Mode | Reads | Writes / mutations |
| --- | --- | --- |
| `plan` | allow | **deny** `write_file`, shell-mutation, `apply_patch` |
| `ask` | allow | **ask** before any mutation |
| `accept_edits` | allow | allow inside `allowed_write_set`; ask for the rest |
| `bypass_workspace` | allow | allow mutations **only inside a registry-confirmed disposable workspace**; deny at the real tree |
| `deny_unlisted` | allow listed | deny anything not explicitly allow-listed |

## Critical: disposability is not self-reported
`bypass_workspace` is meaningless unless the cwd is **proven disposable**. The Gateway
calls the **Workspace Manager / workspace registry** to confirm the resolved cwd is a
harness-created disposable workspace (by manifest), and runs a `realpath`/symlink check
so a link cannot smuggle a write out of it. A `ToolRequest.isDisposableWorkspace` flag
from the caller is **advisory only and must never be trusted**.

## Invariants
The Gateway never trusts agent/tool self-reports for disposability, write-set, or
secret-hygiene. A denial of an out-of-write-set write is a **pre-apply abort**, not a
validation failure. Every decision is recorded as a `permission_*` trace event with its
reasons. See `../validation/03_SECURITY_SCENARIO_TESTS.md`.

## Caller obligations (machine-facing contract)
These are requirements on the *caller* building a `ToolRequest`, enforced by the gateway:
- A **shell mutation** request (any command that writes/deletes) MUST provide resolved
  `targetPaths`. Under `bypass_workspace`, an empty `targetPaths` is **denied by design**
  (the gateway cannot confirm containment) — this is intentional, not a bug.
- `isWrite` MUST be set true for any mutating action; the gateway treats unflagged shell
  commands conservatively but relies on `isWrite` + `targetPaths` for write-set/containment.
- Disposability is resolved by the `WorkspaceOracle`; never pass a self-reported flag.
- `globMatch` is a v0 matcher (supports `*` and `**`); a mature matcher (e.g. minimatch)
  is a ROADMAP:phase-2 upgrade. `forbiddenActions` substring matching is v0; an action-class
  model is a ROADMAP:phase-2 upgrade.

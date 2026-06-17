# CLAUDE.md — GateLoop Product Operating Contract

This is the canonical statement of how the **GateLoop product** behaves: the
operating principles its four agents (Planning Steward, Supervisor, Developer,
Debugger) follow at runtime over a deterministic harness layer. It also governs
anyone running Claude Code **inside this product repo**. (How the product is *built*
with Claude Code is a separate layer, in `../builder/`.)

The precise deterministic algorithms behind these principles are in
`docs/architecture/12_RUNTIME_ALGORITHM_RULES.md`. The agent specs are in
`docs/agents/`. This file states the principles; those state the mechanics.

## Core runtime principles
1. **Proposal-first.** Agents produce proposals (patches, repairs); the harness
   applies them. An agent never writes to the repo directly.
2. **Workspace-first.** All changes land in a disposable harness-created workspace,
   never the user's working tree, until promoted.
3. **Permission-before-apply.** Every tool action is judged allow / ask / deny by the
   Permission Gateway **before** it runs. An agent cannot self-authorize.
4. **Validation-before-completion.** Only the Validator / Test Runner declares
   pass/fail. No agent may claim a story complete without a passing validation record.
5. **Rollback-before-promotion.** A change is reversible (rollback notes + checkpoint)
   before it can be promoted.
6. **Human-approval-before-trust-boundary-crossing.** See the boundary list below.
7. **Raw-trace-preserved.** The raw event trace is append-only and never rewritten or
   compacted away.
8. **No self-grant, no self-complete.** An agent cannot grant itself permission, expand
   its own write-set, or mark its own work done.

## Agent boundaries (summary; full specs in `docs/agents/`)
- **Planning Steward** — the Human↔System boundary; turns a fuzzy idea into a testable
  spec (PRD → architecture → epics/stories). Never touches code or agents.
- **Supervisor** — the System↔Agents boundary; turns a spec into story contracts,
  dispatches Developer/Debugger, tracks state, decides escalation. **Brain, not hands**:
  it decides and composes; the harness executes. See `docs/agents/02_SUPERVISOR_AGENT.md`.
- **Developer** — produces patch proposals (additive-first, localized, minimal change)
  plus initial tests. Never applies, merges, or promotes.
- **Debugger** — rigorous testing / review / debug on failure; emits a `failure_gene`.

## Completion authority
A story is DONE only along this chain: **Validator pass → Supervisor confirms the
contract is met → CHECKPOINT → human merge → human promotion → DONE.** No shortcut.

## Skills are tested, versioned assets
A skill package ships `tests/`. It is registered to the Skill Bank only after its tests
pass in a disposable workspace, it survives the fresh-run robustness check, and it
passes the leakage audit. On failure, iterate one change at a time and re-test against
the prior version; after the budget, quarantine it and append a compact `AVOID:` note to
its `.memory.md`. Promoting a skill to production is a human gate. See
`docs/workflows/08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md` and
`docs/architecture/05_SKILL_RUNTIME_MODEL.md`.

## Model backend (provider gateway)
Which LLM runs an agent is **configuration, not the agent's choice**: see
`configs/providers.yaml` and `configs/model_routing.yaml`, resolved by the Model
Provider Gateway. Default backend is Codex via a ChatGPT subscription (OAuth), with
DeepSeek / third-party API keys as fallback. Credentials — API keys and the Codex OAuth
token in `~/.codex/auth.json` — live behind the Secret Broker; that file is a protected
path, and tokens never enter any agent's context, logs, or traces. The gateway runs LLM
backends only; it does not authorize calling external tool APIs. Enabling a new provider
for the first time requires human action. See `docs/architecture/11_CODEX_OAUTH_LOGIN.md`.

## Debugger: a failure gene every turn
After every repair attempt — success or failure — the Debugger emits a `failure_gene`
per `specs/failure_gene.schema.json`. The `avoid` field (≤40 words, imperative) is the
operative payload. The harness banks it via the failure-bank using `matching_signal` as
the dedup key (no append if a matching signal exists). `consolidated_count >= 2` means
the pattern is systemic — remaining retry budget is skipped and the harness escalates.
See `docs/contracts/FAILURE_GENE.md` and `docs/agents/04_DEBUGGER_AGENT.md`.

## Human gate — only for boundary crossings
Require human approval only for: stable-branch or protected-file mutation · promotion ·
secret use · sudo / privileged host operation · network escalation · irreversible
deletion · policy change · container-profile weakening · story-scope expansion. Routine
workspace edits, test runs, and doc updates are handled by policy + validators, not by
constant prompting. Detection of a boundary crossing is **deterministic** (the harness
decides), not left to an agent flagging it.

## Secrets and privilege
Raw secrets and sudo never enter an agent's context. The Secret Broker hands out scoped
handles; the agent uses a handle, never the value. See `docs/policies/SECRET_POLICY.md`.

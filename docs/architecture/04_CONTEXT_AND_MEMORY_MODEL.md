# Context & Memory Model

How the harness keeps each agent's context correct, bounded, and free of secrets
across a long run. Config: `configs/context_manager.yaml`. Package:
`packages/context-manager`. Rules: `12_RUNTIME_ALGORITHM_RULES.md` §6.

## What an agent sees (a Context Packet)
Each agent receives a **role-scoped, reference-based** packet, not raw history:
- mission · current story/status/constraints · codegraph summary · latest
  validation/debugger summaries · blockers · risks · injected failure-gene `avoid` lines.
- artifacts are passed by **reference** (`artifact_refs`); raw artifacts stay out of the
  active prompt and are fetched on demand.
- **Excluded always:** raw secrets, sudo passwords, unrelated full logs, other work's
  private traces, whole-repo dumps. Redaction runs before anything enters context.

Per-role scoping example: the Supervisor gets summaries (not the full Developer trace);
the Debugger gets the failed logs; the Developer gets the contract + relevant codegraph.

## Memory tiers
- **Active context** — the live prompt window (role-scoped packet + sliding window).
- **Run memory** — summaries + artifact refs for the current run (online cache).
- **Skill memory** — each skill's `.memory.md` (compact lessons; `AVOID:` notes).
- **Failure bank** — cross-run `avoid` genes (see `../contracts/FAILURE_GENE.md`).

## Compaction & re-injection (deterministic)
| Rule | Value |
| --- | --- |
| node compression (L1) | when a node > ~4k tokens |
| chain compression (L2) | when the chain > ~60k tokens |
| pinning | first 3 + last 5 turns never compressed |
| compression floor | never below ratio 0.3 (over-compression hurts) |
| sliding window | last 20 turns live |
| re-inject contract + active genes | every 10 agent calls |
| re-inject rules/invariants | every 20 agent calls |
| per-agent token budget | per `context_manager.yaml` (e.g. developer ≈ 128k) |

Every summary carries a `source_ref` so the raw artifact is recoverable — **compaction
never destroys the raw trace** (that is append-only, see `../contracts/TRACE_SCHEMA.md`).

## v0 scope
v0 does **not** do LLM summarization or skill evolution. It does role-scoped artifact
selection, token-budget enforcement by selection, redaction, and provenance refs.
Compression/summarization functions are specified here but implemented later. Tested by
`../validation/04_CONTEXT_COMPACTION_TESTS.md`.

# Context Inheritance & Compaction Discipline

**Status:** design baseline for EPIC-031 · **Layer:** product docs (architecture)
**Builds on:** 04_CONTEXT_AND_MEMORY_MODEL, 015.5 (compaction), 027.4 (pinned),
023.4 (developer self-carryover), 029.6 (summarizeProgress), EPIC-030 (isolation)

## The two questions, kept separate

Long autonomous runs face two distinct problems, often conflated:

1. **Compaction** — within one agent/story, how to keep context small.
2. **Inheritance** — between stories, what the next story learns from the last.

They have different answers. The unifying rule, consistent with the rest of
GateLoop: **context carries facts and summaries; the workspace and trace hold
the full truth; nothing carries another agent's reasoning.**

## Three sources of truth (none duplicated into context)

- **workspace** — what files currently look like. Read directly; never stored in
  context. (This is why "preserve file order/contents in context" is unnecessary —
  the file state is already authoritative on disk.)
- **trace.jsonl** — the full append-only process record (every call, token,
  checkpoint). This *is* the "local log"; we do not write a second one.
- **context** — only a compacted summary + pinned invariants + the inbound
  handoff card. Everything else is reachable via pointers, not resident.

So the compaction question is not "which lossy encoding of the process do we put
in context" — it is "summary in context, full in trace, files from disk." None of
the three raw-log schemes is adopted; they all try to resident-store what the
trace and workspace already hold.

## Inheritance: the handoff card (facts, never process)

When a story completes it emits a **handoff card** — a tiny, structured, facts-only
record. The next story inherits the card, not the previous story's context.

```yaml
handoff_card:
  story: STORY-010.1
  delivered: [cli_entry, core_service]          # capabilities, as facts
  touched_files: [src/cli.ts, src/core.ts]      # "which files were used"
  acceptance: { result: passed, ratio: "7/7" }
  open_threads: []                               # "unfinished functionality"
  trace_ref: "trace#evt_4821"                    # pointer back to full process
```

What the card deliberately omits: the Developer's reasoning, the debug narrative,
any "how we got there." Carrying those across stories would anchor the next
Developer to the previous one's framing and blind spots — the same contamination
EPIC-030 removed *within* a story, now prevented *between* stories. The two costs
the operator named (larger context = higher cost + higher hallucination rate) are
precisely the costs of inheriting process; the card inherits facts only.

This tightens 023.4: a Developer may see a compacted summary of its OWN prior
story, but cross-story inheritance to a *different* story is restricted to the
card.

## The anti-anchoring invariant, generalized across stories

EPIC-030 severed the Debugger/Assessor from the generator's reasoning within a
story. EPIC-031 extends the same rule across story boundaries:

> No story inherits another story's reasoning. Inheritance between stories is
> facts-only (the handoff card). Tested as an invariant.

## Trace index pointers (lightweight retrievability)

The operator's pointer/index idea, adopted not as compression but as
**retrievability**: every summary entry and every handoff-card line carries a
`trace_ref` (a trace event id, and where relevant a commit sha). An agent that
sees a summary and needs detail can resolve the pointer and pull the original
from the trace — instead of the full text living in context.

```
summary entry:  "refactored cache logic in store.ts"   trace_ref: evt_5170
                                                         commit: 9af3c1
   → on demand: resolve evt_5170 → full reasoning/diff from trace (not resident)
```

This is "light summary + optional deep-dive": context stays small; nothing is
lost, because the pointer reaches the full record. It also makes compaction safe:
a compacted section remains auditable because its pointer still resolves.

## Pinned (never-compress) zone, reaffirmed

Extends 027.4. These never compact, regardless of run length:

- architectural decisions
- active story invariants (forbidden_actions, global gate statuses)
- **inbound handoff card** (the next story must not lose its factual entry point)
- **acceptance intent** (from 030.1 — the correctness bar must survive)

A compaction that would touch a pinned section excludes it and records the
exclusion in the trace.

## What each mechanism owns (summary)

```
within a story   : summary in context (029.6) + pinned zone (027.4/031) + files from disk
across stories   : handoff card, facts-only (031) — no reasoning inheritance
full record      : trace.jsonl (single log) — reached via trace_ref pointers (031)
file state       : workspace (read live) — never resident in context
```

Four mechanisms, one principle: facts and summaries travel; reasoning does not;
the full truth stays in trace/workspace and is reachable by pointer.

# ADR 22 — CodeGraph Wiring (connect the built-but-unconnected seam)

**Status:** proposed (design investigation; zero cost — no engine install/run, no spawn, no real API; `real_api_calls=false`).
**Context:** the readiness report (`LARGE_PROJECT_READINESS.md`, commit 6896967) found codegraph
**built-but-NOT-connected** and named it the **first blocking prerequisite** for a 20+ story project:
context management at scale needs codegraph to locate "the code relevant to *this* story" so an agent
that can't fit the whole codebase in context can find the right files. This ADR decides **how to wire
it** and plans the epic. It does **not** implement.

**Honest correction to the readiness report:** the engine is **not missing** — it is installed and
working. `/home/pollux/.local/bin/codegraph` exists, real `.codegraph/codegraph.db` indexes exist on
this machine (other projects), and the `codegraph_*` MCP tools already run against *this very repo*.
What the report saw as "engine binary absent" was the **dead client's hardcoded stale path**
(`/data/python/codegraph_engine/codegraph-main/dist/bin/codegraph.js` — that exact build subpath
doesn't exist), not the absence of a working engine. The problem is **wiring**, not "does a code-graph
engine exist."

---

## 1. Engine decision (the first-priority question)

### What the existing seam is
- `packages/codegraph-adapter/src/index.ts` — a clean, tested `CodeGraphClient` interface
  (`query({operation, target, readScope})`) + `lookupSymbol` / `computeImpactSet` / `filterToReadScope`
  / `summarizeForContext`, with a `NULL_CLIENT` fallback. **GateLoop is already isolated from any
  particular engine behind this seam** (swappable; CI uses a fixture).
- `scripts/codegraph-client.ts` — `engineCodegraph()` shells out to the `@colbymchenry/codegraph` CLI
  (`init`/`index`/`impact <sym> --json --depth 2`), `fixtureCodegraph()` is the CI client. **It only
  implements `operation:'impact'`** (and self-parses exported symbols via regex to feed it); every
  other operation returns empty. It is the right shape but minimal and points at a stale binary path.

### The engine: `@colbymchenry/codegraph` (web-verified, not assumed)
- **MIT license**; **v1.0.1, released 2026-06-13**; actively maintained (510 commits, 17 releases).
- **Local-first**: SQLite (`.codegraph/codegraph.db`, FTS5), 100% local — **no network/API at query
  time**, no per-query cost. **20+ languages** (TS/JS/Python/Go/Rust/Java/C#/…).
- Incremental indexing + OS file-watcher auto-sync; explicit `init`/`index`/`sync`/`status`.
- Rich CLI, all with `--json`: `query` (symbol search), `node` (definition + dependents), `callers`
  (references), `callees` (outbound calls), `impact` (blast radius), `affected [files]` (test-impact),
  `explore` (context synthesis), `files`, `status`. Also runs as an MCP server (`serve --mcp`).
- **Covers every operation the adapter needs and more** — crucially `query`/`node` provide the
  symbol-location the adapter's dead `symbol_lookup` op requires.
- Already proven on this machine: it indexes this repo for the harness builder's own session.

### Options weighed

| Option | Pros | Cons / 坑 | Verdict |
|---|---|---|---|
| **A. External `@colbymchenry/codegraph` (pinned), isolated behind the existing adapter** | MIT, current (1.0.1), maintained, **already installed & proven on this repo**; 20+ langs; local-first (zero query cost); supports all ops; the adapter already isolates it → not bound; fixture/NULL fallback for CI | Young 1.0 (61 open issues — some churn); must resolve the binary **robustly** (PATH/npx/config, not a hardcoded path — the dead client's exact bug); version drift (mitigate: pin + the isolating seam) | **CHOSEN** |
| **B. Vendored copy** (design once cited `external_references/.../codegraph/`, now absent) | Offline/reproducible; pinned exactly | Vendoring a 510-commit tree-sitter+SQLite tool is heavy ("do not patch — re-vendor to upgrade"); only justified for offline builds we don't need now | Deferred (revisit only if offline reproducibility becomes a hard requirement) |
| **C. Self-build lightweight (ts-morph / tree-sitter / LSP)** | Full control, no external dep; ts-morph could do TS symbol/ref/impact well | Re-implements a maintained MIT tool; **20+ language coverage is a large build**; the 20-story product may not be TypeScript | Deferred fallback (only if A proves unreliable; the seam makes switching cheap) |

**Decision: Option A** — use the external engine, **pinned**, resolved via a robust binary lookup,
kept behind the existing `CodeGraphClient` seam with the fixture/NULL fallback intact. This matches
GateLoop's established "borrow-form, isolate behind a seam, keep a fallback" pattern (cf. the opencode
borrow, the subscription plugin): we get a strong, maintained, multi-language engine **without binding**
— if it ever disappoints, Option C slots in behind the same interface, and CI never depends on it
(fixture client). The young-1.0 risk is carried by the isolation seam + version pin + fixture fallback,
not by the harness.

---

## 2. Index lifecycle

- **Where:** the engine builds `.codegraph/codegraph.db` (SQLite) **per project, inside the workspace**.
  GateLoop's provider path is now in-process (post-EPIC-035); stories run in **host disposable git
  workspaces** (`createDisposableWorkspace`), so the index lives in that workspace's `.codegraph/` on
  the host — no container indirection.
- **When:**
  - **Build once at run start** (`/goal` Step 0, per design `06_CODEGRAPH_INTEGRATION.md`): `init`/`index`
    over the base tree so the first story already has a graph.
  - **Incremental `sync` after each checkpoint** that changed indexed files. **Prefer explicit `sync`
    over the engine's file-watcher auto-sync** — a harness wants deterministic, observable state
    transitions (the project's own "set≠effective, prove it" discipline; a background watcher is exactly
    the kind of magic that can silently lag). The watcher stays available but is not the source of truth.
- **`.codegraph/` is harness state, not agent-writable.** It must be **excluded from the agent
  write-set, from the exit-gate diff, and gitignored** in the generated project — otherwise the index
  leaks into `git diff`/the proposal and trips the write-set gate. (This is a concrete integration story,
  not a footnote.)
- **Cost/time:** SQLite + incremental → index build is seconds on a small/medium generated codebase,
  sub-second per incremental sync; the engine benchmarks 7 real codebases (58% fewer tool calls / 47%
  fewer tokens). Honest caveat: **not yet measured at GateLoop's specific per-story cadence** — Story 6
  measures it. Re-indexing the whole tree every story would be O(n) waste; incremental `sync` avoids it.

---

## 3. Tool backend + per-story query (two modes, both needed)

The readiness report found two empty holes; codegraph fills both, via **two complementary modes** on
**one real client**:

**Mode 1 — Supervisor pre-locates → injects (the context root, PRIMARY).**
Before dispatching a story, the Supervisor uses the real client to locate the story-relevant code —
`query`/`search` on the symbols/keywords the story names, `node`/`callers` on the files it will touch,
`impact` for blast radius — and **fills the currently-empty `relevant_files` + `codegraph_summary`
context sections** in the developer packet. This is deterministic, testable, and is *the* fix for "no
code-relevance retrieval"; the agent starts with the right files in context instead of rediscovering
them by grep every story.

**Mode 2 — agent active query (`query_codegraph` tool, SECONDARY/additive).**
Wire the real client as the codegraph backend so `providerToolSet({ backends: { codegraph } })`
(currently called with **no backends** at `provider-driver/confinement.ts:157`) exposes a live, read-only
`query_codegraph` tool through the confined tool layer. The agent can then dig further mid-run (check
callers before editing, find more refs). Read-only ⇒ no write-set risk; it rides the existing
default-deny tool layer.

Recommendation: **build Mode 1 first** (the context-root fix, deterministic, the biggest lever), then
Mode 2 (additive agent capability). Both share the same `GateloopCodegraph` client.

---

## 4. Verifying it actually works (set ≠ effective)

Acceptance must prove *effectiveness*, not "it's wired" — the project's prove-* discipline:

1. **`symbol_lookup` truly locates (no longer dead/zero-call):** against a known fixture repo, the real
   client returns the actual definition `file:line` for a known symbol (not the empty `NULL_CLIENT`
   result). The op has real callers.
2. **`relevant_files` truly filled (no longer an empty section):** run a story through the Supervisor
   with codegraph wired → assert the developer packet's `relevant_files`/`codegraph_summary` are
   **non-empty** and name the right files.
3. **Located code is truly relevant (precision/recall vs a known answer):** for a story that must modify
   symbol X, the codegraph-located set **⊇ the files a correct patch touches** (measured against a
   fixture with a known-correct diff). Reject "returns something" — measure it returns *the right
   something*.
4. **The single-variable A/B (the real proof):** a multi-story run **with vs without** codegraph
   injection (one variable) → with-codegraph the agent touches fewer wrong files / produces fewer
   cross-story clobbers (ties directly to the convergence wall the readiness report named). Scripted
   fixture for CI; one **gated real-model A/B** for the honest result (this is the only step that costs).

---

## 5. Epic plan — "CodeGraph Wiring"

Scope: connect the engine behind the existing seam, run the index lifecycle, fill context, expose the
tool, and prove effectiveness. **The hard part (a multi-language code-intelligence engine) is already
solved by the MIT tool** — this epic is wiring + lifecycle + injection + verification, not building a
graph. Medium epic, ~6 stories (+1 optional), mostly scripted/local-engine (zero API cost) with one
gated real-model A/B at the end. Note: running the *engine* is local CPU only — **not** a real-API/gated
action; only Story 6's model A/B spends.

| Story | What | Cost | Depends on |
|---|---|---|---|
| **CW.1 Engine binary resolution + real-index smoke** | Replace the dead hardcoded `DEFAULT_BIN` with robust resolution (PATH `codegraph` → `npx @colbymchenry/codegraph` → `CODEGRAPH_BIN` override); **pin the version**; prove `init`/`index`/`status` build a real `.codegraph/codegraph.db` over a fixture repo and a query returns real data. *This is where "the engine works" is PROVEN, not assumed.* | local engine (no API) | — |
| **CW.2 Full adapter ops over the engine** | Extend `engineCodegraph` beyond impact-only: map each `CodeGraphOperation` → the right CLI `--json` command (`symbol_lookup`→`query`/`node`, `dependents`→`callers`, `dependencies`→`callees`, `impact`→`impact`/`affected`) + parse. Make `symbol_lookup` non-dead. | local engine | CW.1 |
| **CW.3 Index lifecycle in the harness** | Build index at run start (Step 0); incremental `sync` after each checkpoint; **exclude `.codegraph/` from agent write-set + exit-gate diff + gitignore**. | local engine | CW.1 |
| **CW.4 Per-story relevant-code → context injection (Mode 1, the context root)** | Supervisor locates relevant files via the real client and **fills `relevant_files`/`codegraph_summary`** in the developer packet. | scripted/fixture | CW.2, CW.3 |
| **CW.5 `query_codegraph` tool backend (Mode 2)** | Pass the real client as the codegraph backend to `providerToolSet`; the read-only tool goes live in the agent surface through the confined layer. | scripted/fixture | CW.2 |
| **CW.6 Verify effectiveness (set≠effective)** | The four proofs in §4: symbol_lookup locates · relevant_files filled · located-code-truly-relevant (precision) · single-variable A/B with-vs-without codegraph. | scripted CI **+ one gated real-model A/B** | CW.4, CW.5 |
| **CW.7 (optional) Finish + register the `codegraph-query` skill** | Complete the draft skill (add `tests/`, pass leakage audit, register) so agents have the documented skill asset. | scripted | CW.5 |

Dependency chain: `CW.1 → CW.2 → {CW.4, CW.5}` · `CW.1 → CW.3 → CW.4` · `{CW.4, CW.5} → CW.6` · `CW.5 → CW.7`.

---

## 6. Honest conclusion

**CodeGraph wiring is feasible and the engine choice is low-risk.** The engine (`@colbymchenry/codegraph`)
is MIT, current, maintained, multi-language, local-first (zero query cost), **already installed and
proven on this repo**, and supports every operation needed — and the adapter seam already isolates it,
so we use it **without binding** (fixture/NULL fallback intact; Option C remains a cheap escape hatch).
The work is genuinely a **wiring epic, not an engine build**: ~6 stories (binary resolution + real-index
smoke → full ops → index lifecycle → per-story context injection → tool backend → effectiveness proof),
mostly scripted/local-engine with a single gated real-model A/B at the end. The two biggest levers are
**CW.4** (fill the empty `relevant_files` context section — the context-management root) and **CW.6's
A/B** (prove it actually reduces cross-story clobber — the link to the convergence wall). Recommended
size: a focused **6-story epic** (CW.7 optional). The main 坑 to respect: resolve the binary robustly
(don't repeat the dead client's hardcoded path), keep `.codegraph/` out of the write-set/diff, and prove
*relevance* (not mere non-emptiness) before declaring it done.

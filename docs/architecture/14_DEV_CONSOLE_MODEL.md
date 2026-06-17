# Dev Console Model (multi-agent CLI view)

**Status:** design baseline for EPIC-023 (mechanics) and EPIC-024 (UI) ·
**Layer:** product docs (architecture)

The development page of the cockpit: three CLI-style agent panes, one input box,
a conversation router with a Planning-Steward takeover protocol, a Story Manager
admission controller, and a parallel grid mode. Styled with Material Design 3
(`@material/web`; reference vendored at `external_references/material-web-main/`).

---

## 1. Layout and the projection principle

```text
┌────────────┬──────────────────────────┬────────────┐
│ Supervisor │   Developer + Debugger   │  Reviewer  │
│  (fixed)   │  (single, or N×N grid)   │  (fixed)   │
├────────────┴──────────────────────────┴────────────┤
│  >  unified input (owner badge: Supervisor)         │
└─────────────────────────────────────────────────────┘
```

**Panes are trace projections, not channels.** Every pane renders the live trace
stream (016.1) filtered by role. There is no separate chat backend: what an
agent did IS what its pane shows. This guarantees the console can never disagree
with the audit trail.

Rendering style — Claude-Code-CLI, not chat bubbles:
- monospace, role-prefixed lines, streaming
- tool / manager invocations as inline annotated lines, e.g.
  `▸ tool: validator.run  story=STORY-009.3  → fail (2 assertions)`
- agent dispatch records, e.g. `▸ dispatch: supervisor → debugger (attempt 2/3)`
- **thinking blocks**: collapsed by default as a semi-transparent 2-line
  preview; click expands the full reasoning inline. Reasoning events come from
  the trace like everything else. (Human sees everything; the *Reviewer agent*
  still never receives implementation reasoning — display ≠ agent context.)

## 2. Per-pane context rules

| Pane | Sees (agent context, not just display) |
| --- | --- |
| Developer | current story + **a compacted summary of its own previous story's development** (carryover rule in context-manager; own stories only, summarized via 015.5, never raw) |
| Debugger | **current development cycle only** — this story, this diff, this failure; plans minimal tests and the smallest repair (local scope by design) |
| Reviewer | global scope — see §5 |
| Supervisor | tracker + run state (as today); narrates, never solves |

## 3. Conversation routing (the single input)

Every user message is intent-classified by the router (deterministic first,
model-assisted only when ambiguous):

| Intent | Owner | Behavior |
| --- | --- | --- |
| status_query ("進度?", "哪個 story 卡住?") | **Supervisor** | answers from tracker/trace — project content only |
| scope_change_request ("我想加...") | **Planning Steward (takeover)** | see §4 |
| approval_response | approval flow | routed to the pending gate |
| off_topic | Supervisor | polite refusal — the console only discusses the project |

The Supervisor never accepts raw instructions as work — that would cross the
Human↔System boundary it does not own. Status narration is read-only.

## 4. Takeover and handback protocol (new story → Supervisor)

The handoff is **mediated by the tracker, never by agent-to-agent chat**:

```text
user: "我想加一個匯出 CSV 功能"
 1. Router classifies scope_change_request → TAKEOVER
    · Supervisor pane owner badge switches to Planning Steward (MD3 color change)
 2. Planning Steward runs intake inline: ambiguity questions render in-pane
 3. Output = a backlog delta (new/changed stories) → MUST pass the bundle gate (009.3)
 4. Delta lands as a tracker transaction: new entries status=todo + EPIC_LIST update
    · trace event: backlog_updated
 5. Story Manager recomputes the admissible set
 6. HANDBACK: badge returns to Supervisor; Supervisor's next select tick sees the
    new stories via the tracker and announces: "已納入 STORY-xxx；排程於 …"
```

Properties: no preemption (the current story finishes; new stories enter the
queue per dependency + selection rule; priority jumps require a human-confirmed
reorder); no side channel (if the tracker doesn't show it, it didn't happen);
the spec-discussion page (016.4) remains the primary place for big ideas — the
console takeover is for mid-run additions, same pipeline, same gate.

## 5. Reviewer: local vs global (the concrete division)

The Debugger asks "**why did this test fail and what is the smallest fix**".
The Reviewer asks "**is this change right for the whole project**":

| # | Global duty | Uses |
| --- | --- | --- |
| 1 | Cross-story consistency — naming/pattern/error-handling divergence from the rest of the project; duplicated logic that already exists elsewhere | conventions profile (015.4) |
| 2 | Acceptance-intent drift — does the diff satisfy the *intent* of the criteria or merely game the tests | pairs with test-author integrity (015.3) |
| 3 | Architecture conformance — layering, dependency direction, public-API stability vs the planning bundle / as-is recovery | planning bundle; brownfield as-is (020.1) |
| 4 | Regression surface — impact beyond the write-set: what else could this break | CodeGraph impact set (015.2) |
| 5 | Systemic failure recognition — is this an instance of a known gene family across stories | failure bank, global view (008.3/022.5) |
| 6 | Churn outlier → re-scope recommendation — attempts/diff-size disproportionate to scope signals a mis-scoped story; recommend re-scoping to the Supervisor (advisory) | tracker stats |
| 7 | **Per-cycle gate review** — in parallel mode, every completed developer+debugger cycle is reviewed before its result reaches the Supervisor | diagnosis report v2 |

Diagnosis report v2 adds global findings: `consistency_violations`,
`architecture_conformance`, `regression_surface`, `rescope_recommendation`.
`review.trigger` gains `on_cycle_complete` (the parallel-mode default).
All Reviewer output remains advisory; it still holds no write-set.

## 6. Story Manager (admission controller)

Dependencies alone don't capture "this story must not start yet". The Story
Manager is a **deterministic harness component** (not an agent) between the
tracker and the Supervisor/scheduler. A story is **admissible** only if ALL:

1. all `depends_on` are done (existing rule)
2. **no human hold** on the story (hold/release requires human confirm; the
   Supervisor may *propose* a hold, never place one)
3. its **wave/milestone** is open (wave N+1 closed until wave N checkpointed)
4. **WIP limit** for its epic/write-set domain not exceeded
5. **write-set does not overlap** any story currently running (extends the
   017.1 pre-spawn check into continuous admission)
6. budget available for admission

In parallel mode the Story Manager feeds free grid cells from the admissible
set. Every admit/deny/hold/release is a trace event.

## 7. Parallel grid mode

- Supervisor and Reviewer panes stay fixed left/right.
- The center becomes an N×N grid (2×2, 4×4, …; sized from
  `parallelism.max_workers`), one developer+debugger cell per worker; click a
  cell to zoom (MD3 expressive motion), others collapse to status chips.
- Cycle flow per cell:
  `dev+debug cycle completes → Reviewer reviews (trigger: on_cycle_complete)
   → diagnosis to trace → Supervisor reads verdict → checkpoint or re-route
   → Story Manager admits the next story into the freed cell`
- The Reviewer pane shows a review queue (one entry per completed cycle); the
  Supervisor pane narrates admissions and verdicts.

## 8. Material Design 3 integration

- `@material/web` as an npm dependency of `apps/web` (web components work in
  the Vite + React app via custom elements); MD3 design tokens for theming,
  dark mode default for the console.
- Role color-coding via MD3 color roles (Supervisor=primary,
  Developer=secondary, Debugger=tertiary, Reviewer=inverse/neutral accent),
  used for pane headers, owner badges, and the takeover switch animation.
- Reference source vendored read-only at `external_references/material-web-main/`.

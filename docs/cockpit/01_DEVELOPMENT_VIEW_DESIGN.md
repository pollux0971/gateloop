# Cockpit Development View — Design Spec

**Status:** design baseline for EPIC-023 · **Layer:** product docs (cockpit)
**Style:** Material 3 (Material You), via vendored `@material/web` 2.4.1
(`gateloop/vendor/material-web`). Theme with M3 design tokens / CSS custom
properties — never edit vendored sources.

This is the live, transparent view into an autonomous run: terminal-style, not
chat bubbles. Like the Claude Code CLI — monospace, plain text, dense.

---

## 1. Layout

### Single-story mode (default)

Three vertical panes, each a scrolling terminal transcript (no bubbles):

```text
┌───────────────┬───────────────────────┬───────────────┐
│  SUPERVISOR   │  DEVELOPER + DEBUGGER  │   REVIEWER    │
│  (routing,    │  (the active build:    │  (global      │
│   decisions)  │   propose → test →     │   review)     │
│               │   repair, interleaved) │               │
├───────────────┴───────────────────────┴───────────────┤
│  > bottom input — talks to Supervisor (persona-aware)  │
└────────────────────────────────────────────────────────┘
```

The center pane interleaves Developer and Debugger turns for the current story
(they are one tight local loop). Supervisor and Reviewer flank it.

### Parallel mode

Supervisor and Reviewer stay pinned left and right. The center becomes a grid of
Developer+Debugger panes — 2×2, 3×3, 4×4, scaling with `parallelism.max_workers`:

```text
┌──────────┬───────────────────────────────┬──────────┐
│SUPERVISOR│  [D+D #1] [D+D #2] [D+D #3]    │ REVIEWER │
│          │  [D+D #4] [D+D #5] [D+D #6]    │          │
│          │  click any pane → expand       │          │
├──────────┴───────────────────────────────┴──────────┤
│  > bottom input                                       │
└───────────────────────────────────────────────────────┘
```

Each grid cell is a worker's local transcript. Click → expand to full center
width; the others collapse to tab strips. When a worker finishes one dev→debug
cycle, the harness triggers a Reviewer pass; the Reviewer reports to the
Supervisor (right pane shows the diagnosis, left pane shows the routing decision).

---

## 2. What each pane shows (transparency model)

Every pane is the agent's **live context transcript**, rendered as plain text:

- **agent turns** — what the agent emitted, monospace, streamed.
- **thinking preview** — the agent's `</think>` content rendered **semi-transparent
  (≈45% opacity)**, collapsed to the first lines; click to expand the full chain.
  Applies to **all five agents** (user choice). Thinking is visually de-emphasized
  so the eye lands on actions, but it is always one click from full audit.
- **agent call records** — each model call: provider/model id, token count,
  latency, pass/fail. (For the Reviewer, the cross-model id is shown here.)
- **tool / manager call records** — every gateway-mediated tool call, every
  Story-Manager / Supervisor decision, rendered inline as dim system lines
  (e.g. `· gateway: test-runner → 3 passed, 1 failed`).

Rendering rules: monospace, no avatars, no bubbles, ANSI-ish severity coloring
(dim/normal/warn/error) using M3 color-role tokens. The transcript is the trace,
filtered to that agent.

---

## 3. The three agent roles, made precise

### Developer — local, with one-story memory
- Sees: the current story contract + **its own previous story's development
  process** (carried forward so it keeps continuity of style and approach).
- Does: localize, propose a minimal patch, write initial tests.
- Does NOT: see other concurrent workers; touch other stories.

### Debugger — local, this-change-only
- Sees: **only the current story's diff and its test results** — nothing global.
- Does: plan simple tests, run local triage, propose a minimal repair, emit a
  failure gene. Scope is deliberately narrow: "is *this change* correct?"
- Does NOT: reason about cross-story impact (that is the Reviewer's job).

### Reviewer — global (the complement to the Debugger)
The Debugger asks "is this change correct?"; the Reviewer asks "**does this
change fit the whole project?**" Concretely, four global checks the Debugger
structurally cannot do:

1. **Cross-story consistency** — does the patch honor interfaces/patterns
   established by already-done stories? (contract drift)
2. **Architecture drift** — naming, layering, dependency direction vs the
   project conventions profile (015.4).
3. **Regression risk** — does the impact set (codegraph, 015.2) reach any
   already-checkpointed story?
4. **Improvement directions** — ranked, global-perspective directions
   (the diagnosis report, EPIC-022).

Reviewer stays read-only and anti-anchored (06_REVIEWER_AGENT.md): it never sees
the Developer/Debugger reasoning, only the failing output, the diff, acceptance,
and genes. After each dev→debug cycle it reports to the Supervisor.

---

## 4. The bottom input — Supervisor with Planning-Steward handoff

One input box. Default addressee: **Supervisor**, which answers **only
project-relevant questions** (progress, status, what's blocked, what's next). It
declines off-topic chatter — it is a project console, not a general chatbot.

**Persona handoff (same box, no page switch):**

```text
user types → intent classifier
   ├─ progress / status / "what's next"  → Supervisor answers
   └─ "add a feature / change scope"      → header fades: SUPERVISOR → PLANNING STEWARD
                                            Planning Steward takes over the box,
                                            runs a spec dialogue, produces story drafts
```

The pane header shows the current persona with a soft Material fade transition.
The user never leaves the development view. (Heavier ideation still belongs in
the dedicated spec-discussion view; this in-box handoff is for quick mid-run
additions.)

### How a new story hands control back to the Supervisor

New stories must **not** jump the execution queue. The flow:

```text
Planning Steward drafts story
  → Story Manager (deterministic guard, NOT an agent) validates:
       · schema-valid contract?      · dependencies exist & acyclic?
       · write-set scoped?           · does it pass the bundle gate?
  → if ok: write to tracker as todo  (never selectable until deps are done)
  → control returns to Supervisor
  → Supervisor reports in-box: "Added N stories; they enter the queue once
     their dependencies complete. Current target unchanged: STORY-XXX."
```

The Story Manager is the gatekeeper that prevents premature development: it is
the single component that decides whether a story is *eligible* to be selected,
enforcing dependency order deterministically (no LLM, no judgment, just rules).

---

## 5. Story Manager (deterministic guard)

Not a sixth agent — a harness component, like the permission gateway. Owns one
question: **"is this story allowed to start right now?"**

- Admits a story to the selectable set only if every `depends_on` is `done`.
- Rejects new drafts that are malformed, cyclic, or out-of-scope.
- In parallel mode, it is the authority that stops any worker from grabbing a
  story whose dependencies are unmet — the gate that makes premature execution
  structurally impossible.
- Deterministic and testable; emits its admit/reject decisions to the trace.

---

## 6. Material 3 styling notes

- Components from `@material/web`: `md-tabs` (pane/worker tabs), `md-list`
  (call records), `md-dialog` (expanded thinking / expanded worker), `md-icon-button`
  (expand/collapse), `md-circular-progress` (active turn), `md-filled-text-field`
  (bottom input).
- Theme via M3 design tokens (`--md-sys-color-*`, `--md-sys-typescale-*`).
  Default to a dark terminal surface with M3 dynamic-color accent roles.
- Monospace type for transcripts; M3 typescale for chrome (headers, labels).
- Thinking preview opacity ≈ 0.45; call/tool records use `--md-sys-color-outline`
  for the dim system-line look.

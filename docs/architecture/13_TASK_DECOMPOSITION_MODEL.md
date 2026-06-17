# Task Decomposition Model

Developer and Debugger raise their success rate by breaking one Story into **small,
verifiable subtasks** and working them one at a time (smaller steps ⇒ higher per-step
success; bounded context). This is internal planning **within** a StoryContract — it is
not a new permission and does not cross a trust boundary. Package: `packages/task-graph`.
Schema: `specs/task.schema.json`.

## Ownership & safety
- The subtask store is **harness-owned deterministic state** (like `tracker_state.json`),
  driven by the agent via four tools but enforced by the harness.
- A subtask **inherits** the parent contract's `allowed_write_set` / `forbidden_actions`
  and may **never widen** them. `task-graph` rejects any subtask whose `files_touched`
  fall outside the contract write-set. This preserves no-self-grant.
- Completion of the **story** still flows through the normal chain (Permission Gateway →
  Validator verdict → checkpoint → human gate). Marking subtasks `done` is planning
  progress, not story completion.
- v0 is single-thread: **at most one subtask `in_progress`** at a time.

## The four tools (agent-facing)
| Tool | Effect | Gateway |
| --- | --- | --- |
| `TaskCreate(intent, files_touched?, depends_on?, acceptance_behavior?)` | append a subtask (scope-checked) | allow (harness state, not a repo write) |
| `TaskUpdate(task_id, {status\|notes\|result_ref})` | constrained status transition | allow |
| `TaskList({status?})` | ordered working set (compact, for context) | allow |
| `TaskGet(task_id)` | full subtask | allow |

These tools touch harness task state, not the repository, so the Permission Gateway
allows them; the write-set is still enforced when a subtask's patch is proposed/applied.

## Subtask lifecycle
```text
pending → in_progress → done        (a subtask that produces an artifact is validated)
            │            ↘ blocked → in_progress
            ↘ abandoned
```
`next()` returns the lowest-sequence `pending` subtask whose `depends_on` are all `done`.

## Relationship to the hierarchy
```text
Planning Steward:  idea → epics → stories
Supervisor:        story → StoryContract → Task Packet (per agent)
Developer/Debugger: Task Packet → [TaskGraph: subtask, subtask, …] → patch proposal(s)
```
The subtask layer is the agent's private decomposition of one Task Packet; the contract
remains the enforceable envelope around all of it.

## Shared coding substrate
`task-graph` is the first shared component of a Developer/Debugger **coding substrate**
(shared tools: task-graph + codegraph + workspace + patch-proposal format). The two
agents stay distinct roles but reuse this substrate (see `agents/00_AGENT_BOUNDARIES.md`).

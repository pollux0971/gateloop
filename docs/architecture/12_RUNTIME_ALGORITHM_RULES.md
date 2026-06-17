# Runtime Algorithm Rules

The deterministic rules the **harness** (non-LLM) implements. The LLM agents do
**not** improvise any of these — they are the precise, auditable mechanics behind
the principles in `../../CLAUDE.md`. Where a config file is the machine-readable
source, it is named; keep this doc and the config in sync.

Convention: rules are stated as decision tables or compact pseudocode. "Decided
by harness" means no LLM is in the loop for that step.

---

## 1. Orchestrator tick (the loop)

The Orchestrator owns the loop; the Supervisor is an LLM woken only at ★ points
(see `02_RUNTIME_STATE_MACHINE.md`). One `tick()` does exactly one action.

```text
tick():
  state   = load(tracker_state.json)            # Orchestrator is the only writer
  if run_iterations_used >= run_iteration_budget: stop_run("budget"); return
  row     = decision_matrix.first_match(state)  # configs/decision_matrix.yaml
  if row.actor == supervisor: decision = wake_supervisor(state)   # ★
  else:                       decision = row.action               # automatic
  result  = execute(decision)                   # gateway/validator/workspace/…
  write(tracker_state.json, advance(state, result))
  append(decision_log.md, one_line(decision, result))   # append-only, never rewritten
  if result.stop_condition: write_resume_summary(); stop()
```

Rules: exactly one action per tick · tracker written every tick · decision_log is
append-only · on any stop condition, persist + emit a resume summary (never spin) ·
never auto-cross a human gate.

---

## 2. Story selection (DAG)

```text
select_next_story(stories):
  selectable = [s for s in stories
                if s.status == ready and all(dep.status == done for dep in s.depends_on)]
  if not selectable:
     if any dep is blocked/escalated: escalate_human("blocked dependency"); return None
     if all stories done:            stop_run("complete");               return None
  return min(selectable, key=(priority, order_index))   # lowest first
```

Rules: a story is selectable only when every dependency is `done` · ties broken by
explicit priority then declared order · a blocked/escalated dependency with no
selectable work → human gate, not silent stall.

---

## 3. Attempt & run budgets

Source: a story's `attempt_budget` (story_contract) + the run budget (tracker).

| Counter | v0 limit | On reaching limit |
| --- | --- | --- |
| developer attempts (per story) | 2 | `ask_human` (attempt budget exceeded) |
| debugger attempts (per story) | 2 | `ask_human` |
| same failure signature (per run) | 2 | `ask_human` (repeated-failure loop) |
| run iterations (per run) | configured | `stop_run` (budget) |

Rules: counters are harness-maintained, not agent-reported · the same-signature
counter is compared **within a single run, in memory** (cross-run is the failure
bank, §8) · reaching any limit stops automatic retry.

---

## 4. Permission decision — allow / ask / deny (BEFORE apply)

Decided by the Permission Gateway **before** a tool action runs. Source:
`configs/policy.yaml` + the active mode + the story contract's `allowed_write_set`
/ `forbidden_actions`. This is **not** validation; a denied action never lands.

```text
decide(action, mode, contract):
  if action.touches_secret or action.uses_sudo:                 return ASK_or_DENY  # never silent allow
  if action.path in protected_paths:                            return DENY (or ASK if policy says escalate)
  if action.is_write and action.path not in contract.allowed_write_set: return DENY  # out-of-write-set
  if action.type in contract.forbidden_actions:                 return DENY
  return mode_rule(mode, action)

mode_rule:
  plan            → allow reads; DENY write_file / shell-mutation / apply_patch
  ask             → allow reads; ASK before any mutation
  accept_edits    → allow writes inside allowed_write_set; ASK for the rest
  bypass_workspace→ allow mutations ONLY inside a harness-created disposable workspace; DENY at repo root
  deny_unlisted   → DENY anything not explicitly listed
```

Rules: secrets/sudo are never silently allowed · `bypass_workspace` is workspace-only
and never applies at the real working tree · the Gateway trusts the contract, never
the agent's self-report · a denial → `abort_attempt` (discard workspace changes); if it
implies needed scope → `ask_human` (then §11 contract revision).

---

## 5. Validation verdict (AFTER apply)

Decided by the Validator / Test Runner only. Failure types: `test` · `typecheck` ·
`lint` · `runtime` · `schema`. **`policy_violation` is never a Validator outcome**
(that is §4, caught earlier).

```text
verdict(contract):
  run(contract.validation_commands)
  passed = all(required_validators green) and write_set_check and secret_hygiene_check
  return passed ? PASS : FAIL(failure_type)
```

Rules: only the Validator declares pass/fail · `PASS` requires every
`required_validator` green plus the write-set and secret-hygiene checks · an agent
saying "done" is not a verdict.

### Acceptance-test integrity
`PASS` is trustworthy only if the implementer could not rig the tests it is judged by.
Therefore the tests encoding `acceptance_criteria` are authored by **someone other than
the implementer** (Debugger/QA, or supplied in the task packet), **or** a human confirms
at checkpoint that the tests map to the acceptance criteria.

---

## 6. Context compaction & re-injection

Source: `configs/context_manager.yaml`. Implemented by the Context Manager.

| Rule | Value |
| --- | --- |
| node compression (L1) | compress a single node when it exceeds ~4k tokens |
| chain compression (L2) | compress the chain when it exceeds ~60k tokens |
| pinning | always keep the first 3 and last 5 turns uncompressed |
| compression floor | never compress below ratio 0.3 (over-compression hurts) |
| sliding window | keep the last 20 turns live |
| re-inject contract + active genes | every 10 agent calls |
| re-inject rules/invariants | every 20 agent calls |
| per-agent budget | per `context_manager.yaml` (e.g. developer ≈ 128k) |

Rules: pinned turns are never dropped · compression stops at the floor · the contract
and active failure genes are re-asserted on a fixed cadence so long runs do not drift.

---

## 7. (reserved — see §6 and §8)

---

## 8. Failure-gene matching & dedup

Source: `configs/failure_bank.yaml` + `specs/failure_gene.schema.json`. Implemented by
the failure-bank.

```text
on_debugger_gene(g):
  if exists(bank, signal_matches(g.matching_signal)):   # any-token match
      consolidate(existing): existing.consolidated_count += 1     # do NOT append a duplicate
  else:
      bank.append(g)                                              # up to max active (50)

inject_before_risky_turn(active):
  picks = relevant(active, by=any_token_match)[:5]      # ≤5 per turn, AVOID-only payload
  return [p.avoid for p in picks]

systemic_check(g):
  if g.consolidated_count >= 2:  skip_remaining_retry_budget(); escalate()
```

Rules: `matching_signal` is an any-token match (compact signal beats fuzzy retrieval) ·
dedup on that signal — never bank a duplicate · only the `avoid` field (≤40 words) is
injected, ≤5 per turn · re-injected on the §6 cadence · `consolidated_count >= 2` = systemic
→ stop retrying and escalate.

---

## 9. Skill-lifecycle gating

Source: `specs/skill_package.schema.json`; see `05_SKILL_RUNTIME_MODEL.md` and
`../workflows/08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md`.

```text
register(skill):
  require skill.tests present
  run skill.tests in a disposable workspace
  require fresh_run_robustness_pass        # re-run from clean state
  require leakage_audit_pass               # no env/secret/path leakage
  if all pass: status = registered
  else:        iterate one change at a time, re-test vs previous version
               if iteration_budget exhausted: quarantine; append "AVOID:" to .memory.md
promote_to_production(skill): HUMAN_GATE
```

Rules: no tests → not registerable · registration requires pass + fresh-run + leakage
audit · iterate one change at a time · production promotion is a human gate.

---

## 10. Model routing & fallback

Source: `configs/providers.yaml` + `configs/model_routing.yaml`. Resolved by the Model
Provider Gateway. See `11_CODEX_OAUTH_LOGIN.md`.

```text
resolve(agent, task_class):
  provider = model_routing.lookup(agent, task_class)   # which LLM, by config
  try:    return call(provider)                         # default: Codex via ChatGPT OAuth
  except provider_unavailable:
          return call(model_routing.fallback)           # e.g. DeepSeek / API key
```

Rules: which LLM runs an agent is **configuration, not the agent's choice** · default
backend Codex (OAuth) → fallback DeepSeek / third-party API · the gateway runs LLM
backends only (it does **not** authorize external tool-API calls) · enabling a new
provider for the first time (e.g. Codex browser sign-in) is a human action · the OAuth
token / API keys live behind the Secret Broker and never enter agent context.

---

## 11. Scope-expansion → contract revision

Triggered when a human approves expanding scope (e.g. a Debugger repair needs files
outside the write-set).

```text
on_human_approve_scope(delta):
  orchestrator.record(write_set_delta = delta)   # harness records the grant
  contract.contract_version += 1
  supervisor.reissue_task_packet(contract)        # new write-set; Gateway now permits it
```

Rules: only a human can grant the delta · the Orchestrator records it and bumps
`contract_version` · the Supervisor reissues a revised packet — no actor may change a
write-set without this path (otherwise an approval cannot be enforced and the loop
deadlocks).

---

## 12. Completion authority chain

```text
PASS (Validator)
  → Supervisor confirms the contract's acceptance is met
  → CHECKPOINT (workspace state recorded, rollback notes present)
  → human merge        (trust-boundary crossing)
  → human promotion    (trust-boundary crossing)
  → DONE
```

Rule: a story reaches DONE only along this chain. No agent — including the Supervisor —
may declare promotion complete.

---

## Invariants (always true)

1. Agents propose; the harness applies. No direct agent writes.
2. Changes live in a disposable workspace until promoted.
3. Permission is decided before apply; agents never self-authorize.
4. Only the Validator declares pass/fail; completion needs a passing record.
5. Trust-boundary crossings need human approval; their detection is deterministic.
6. The raw trace is append-only and never rewritten.
7. Raw secrets/sudo never enter agent context.
8. Budgets and counters are harness-maintained, not agent-reported.

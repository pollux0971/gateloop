# 25 — Gate Philosophy: gates face the agent, not the user

> ⚠️ **ADR-0013 (operator-trust) — no execution-side wall (STORY-TRUST.4 doc sweep).** GateLoop has **NO** sandbox / egress / isolation / container protection — that cage was never actually built. Any sandbox/egress/isolation/container text below is **SUPERSEDED design that does NOT describe a present protection** (leave no phantom defense). Execution runs **direct on the host**; the operator is fully trusted (risk level = running any local AI coding tool with auto-run). The one real, **KEPT** execution-side mechanism is the **tool-layer proposal-shaping (no Bash by construction)** — that is real and is NOT removed; it is not a wall. See `ADR/ADR-0013-no-sandbox-operator-trust.md` (reopen it only if ever exposed to untrusted multi-tenant use).

Status: **Proposed** (investigation/design only — nothing implemented; `real_api_calls`
stays `false`). Date: 2026-06-22. Author: builder investigation.

Companion: `02_RUNTIME_STATE_MACHINE.md`, `03_TOOL_AND_PERMISSION_MODEL.md`,
`configs/decision_matrix.yaml`, `05_SKILL_RUNTIME_MODEL.md`, `gateloop/CLAUDE.md`
(core runtime principles), `policies/PROMOTION_POLICY.md`. ADRs it builds on (does NOT
overturn): ADR-0004 (permission gateway), ADR-0005 (no raw secrets), ADR-0006 (bypass
is workspace-only), ADR-0008 (skills require tests), EPIC-034/035 (tool-layer
confinement), EPIC-UST (skills effective).

---

## 0. The principle (GateLoop's identity)

> **GateLoop governs the agent strictly and trusts the user completely.
> The gates face the agent, not the user.**

Three kinds of "stop", told apart by ONE question —
**does this stop the *agent's behaviour*, or the *user's decision*?**

1. **Agent guardrails** — block the *agent* from doing something unsafe (write outside
   scope, run a shell, delete existing behaviour, read a secret, spend money, escalate
   privilege, let an untested skill steer it). **Keep and strengthen. Always.**
2. **User-decision blockers** — stop to ask the *user* to confirm something the user is
   entitled to decide (toggle a skill, pick a direction, change non-guardrail config,
   advance the build). **Remove / simplify.** This is the approval friction the user is
   actually annoyed by.
3. **Protect-the-user fallbacks** — guard the *user* from an accident (back up before a
   force-push, verify before a sync). **Do them silently and automatically — never as a
   stop-and-ask.**

This is ponytail discipline applied to process: **delete redundant approval friction,
never delete a protection** — exactly as ponytail deletes redundant code but never the
trust-boundary validation / error handling / security.

## 1. The operational test (how to classify any mechanism)

```
Does the mechanism block the AGENT's action?
  └─ YES → it is an AGENT GUARDRAIL. Keep it. (Even if it "looks like an approval":
            a skill test-gate and the real_api_calls fail-closed gate are guardrails —
            they constrain the agent/system, not the user's choice.)
  └─ NO, it stops to involve a human about a USER decision →
        Is the human there to APPROVE the user's own choice, or to keep the AGENT
        from self-authorising it?
          ├─ keeping the AGENT from self-authorising (e.g. "agent may not self-promote")
          │     → keep the BARRIER (no agent self-grant) but make the USER's approval
          │       frictionless (pre-authorise / one-click / batch). The gate is on the
          │       agent, the speed is for the user.
          └─ purely the user's choice with no agent-safety content (toggle a skill,
                pick a direction, change cosmetic config)
                  → REMOVE the stop. The user decides; the system obeys.
Is the stop actually a PROTECTION for the user (backup/verify)?
  └─ YES → do it AUTOMATICALLY, silently. Never a stop-and-ask.
```

Litmus phrases:
- "This keeps the agent from …" → guardrail, keep.
- "This makes the user confirm something they already decided" → remove.
- "This protects the user's repo/money/data from an accident" → automate silently.

## 2. Relationship to existing ADRs (clarification, not reversal)

Everything EPIC-034/035/CW built — the exit gate (write-set), the tool layer
(default-deny, no Bash), isolation (no secret reads), the regression / spec-conformance
gates, the additive gate + Observe, the `real_api_calls` fail-closed gate, the skill
test-gate — is **category-1 (agent guardrails) and is fully retained**. This ADR does
**not** loosen any of them. It only says: the **approval / human-confirmation** layer
should relax toward the *user* (categories 2 and 3). Strict on the agent; smooth for the
user.

---

## 3. Inventory & classification of every "stop / confirm / gate"

Surveyed: `harness-core::checkHumanGate` + `HumanGateReason`, the
`decision_matrix.yaml` `human_gate_triggers` + `stop_actions`, the `/goal` loop stop
conditions, the skill lifecycle, the completion/promotion chain, and the cockpit.

### 3a. KEEP — agent guardrails (block the agent, not the user)

| Mechanism | Where | Blocks the agent from… |
|---|---|---|
| Exit gate / write-set (`scope_expansion`, `exceed_story_write_set`) | harness-core, decision_matrix | writing outside the story's allowed files |
| Tool layer default-deny + deny Bash | provider-driver, providerToolPolicy | running arbitrary shell / unlisted tools |
| Additive gate + Observe (`assertDeveloperObservedBeforeEmit`) | developer-runtime | deleting existing behaviour / shipping unverified |
| Isolation / secret-path refusal | providerToolPolicy `PROVIDER_SECRET_PATH` | reading `.env`/keys/credentials |
| Spec-conformance HARD gate, regression gate | harness-core, validators | shipping a non-conforming/regressing patch |
| **Skill test-gate / lifecycle** (validate→test→register→quarantine) | skill-runtime, skill-tester | letting an **untested skill steer the agent** — guardrail, NOT a user block |
| **`real_api_calls` fail-closed gate** | gate-control `runGated` | the **agent/system spending the user's money** unintentionally — protects the user |
| `sudo_or_irreversible`, `container_profile_weakening`, `network_escalation`, `stable_or_protected_path_mutation`, `secret_use`, `irreversible_deletion` | decision_matrix human_gate_triggers | privilege/blast-radius escalation by the agent |
| No self-grant / no self-complete / no self-promote | CLAUDE.md, validators | the agent authorising or completing its own work |

These are deterministic and **harness-detected, never agent-self-reported** — that
property is itself a guardrail and stays.

### 3b. SIMPLIFY — user-decision blockers (approval friction to relax)

| Stop | Where | Why it's friction | Simplification (keep any agent-safety core) |
|---|---|---|---|
| Per-epic / per-sub-step "STOP and report to human" barriers | operator-prompt driven (e.g. CW.6, UST.4 barriers) | the agent pauses for the user to say "continue" on the user's own roadmap | `/goal` auto-advances within an epic; stops only at a real trust boundary, epic completion, or a budget/`real_api_calls` boundary — not at every sub-step |
| `run_budget_exceeded` full stop | harness-core | stops the whole run when one budget hits | auto-continue to the next independent story where safe; stop only when the *selectable set* is empty |
| `policy_change` human gate (all policy edits) | decision_matrix | the user changing their own non-guardrail config has to pass a gate | gate ONLY policy edits that **weaken a guardrail** (tool layer / isolation / write-set / `real_api_calls`); apply-and-log other config changes |
| Promotion (workspace→stable) human approval | PROMOTION_POLICY, human gate | the user must click approve per story | keep the **barrier that the agent cannot self-promote**, but make the user's approval frictionless: pre-authorise / batch / one-click. (The gate faces the agent; the speed is for the user.) |
| Skill enable/disable, direction choice, model/routing pick | (routing already a cockpit PUT) | these are pure user choices | no gate — instant, user decides (see §4) |

### 3c. AUTOMATE SILENTLY — protect-the-user fallbacks (never stop-and-ask)

| Protection | Today | Make it… |
|---|---|---|
| Backup (bundle) before a GitHub force-push | manual discipline (CLAUDE.md) | automatic pre-push hook/step — runs, logs, never asks |
| Fresh-clone verify + secret scan before sync | manual discipline | automatic pre-sync step — runs, blocks only on a real secret hit (that's an agent/data-safety guardrail), else silent |
| Checkpoint + rollback notes before promotion | mostly automatic | keep automatic |

These are *for* the user; they must not become approval prompts.

---

## 4. Frontend skill management design (user decides; guardrails hold)

### 4a. Current state (inventory)
- `skill-runtime` has **status** (`draft/needs_tests/registered/quarantined`) but **no
  `enabled` flag and no `built-in` concept**. `selectSkillsForRole`/
  `loadMountedSkillsForRole` filter on `status === 'registered'` only.
- Cockpit skills are **display-only** (`GET /api/skills`, `/api/skills/:id`; `SkillsPage`
  only views content). The cockpit already has *some* control (`PUT /api/routing`,
  `/api/router-config`) and a **mock** approval center — so "cockpit is purely read-only"
  is already not strictly true; adding skill controls is a consistent next step, gated by
  the §4d safety boundary.

### 4b. Minimal additions (ponytail-restrained — no marketplace)
1. **`enabled` flag per skill** (default true). Runtime filters add `&& enabled`. Toggling
   is a **pure user decision → instant, no gate**.
2. **`builtin: true` marker** for `developer.ponytail-lazy` + `reviewer.ponytail-review`
   (shipped by default). A built-in may be **disabled** (not forced on the user) but **not
   deleted** — it's reinstallable product content.
3. That's it. No ratings, no remote marketplace, no per-skill versjuggling UI in v1.

### 4c. The user-facing operations
| Operation | Gate? | Rationale |
|---|---|---|
| Enable / disable any skill | **none** — instant | the user's choice; never blocked |
| Add a new skill | **lifecycle test-gate** (validate→test→register) | the gate is an **agent guardrail** (an untested skill could steer the agent wrong) — like an app store scanning for malware before install, NOT blocking the user from choosing to install |
| Delete a non-builtin registered skill | **none** — instant | the user's choice |
| Disable a builtin (ponytail) | **none** — instant | not forced; user can opt out |
| Delete a builtin | **refused** (disable instead) | it's product content, reinstallable |

### 4d. Cockpit safety boundary (the critical line)
Going from display-only to control means stating exactly what the frontend may and may
NOT do:

- **Allowed from the frontend (user decisions / approvals):** enable/disable a skill, add
  a skill (→ test-gate), delete a non-builtin skill, pre-authorise / approve a pending
  promotion, edit non-guardrail config.
- **NEVER reachable from the frontend (agent guardrails — server refuses):**
  - weaken the exit gate / tool layer / isolation / write-set;
  - register a skill **bypassing** the test-gate;
  - flip `real_api_calls` on (stays operator/`runGated`-only);
  - trigger any privileged/agent execution or self-promotion.
  The skill-control API must **enforce** this server-side (the boundary is code, not UI
  politeness) — the same "harness decides, not the client" property as the human gates.

---

## 5. Plan (ponytail-minimal)

Proposed **EPIC-GATE — gates face the agent, not the user**. Two tracks; the approval
track is mostly cheap (doc + loop discipline), the frontend track is the real build.

| Story | Track | Scope | Size |
|---|---|---|---|
| GATE.1 | approvals | `/goal` within-epic auto-advance: stop only at trust boundaries / epic-done / budget / `real_api_calls`. Encode the §3b matrix change. | S (loop doc + decision_matrix + tracker) |
| GATE.2 | approvals | Auto protect-user fallbacks: pre-push backup + pre-sync verify/secret-scan as automatic steps (§3c). | S (scripts) |
| GATE.3 | approvals | Policy human-gate narrowed to **guardrail-weakening** edits only; other config apply-and-log (§3b). | S–M |
| GATE.4 | frontend | skill-runtime `enabled` + `builtin` fields + runtime filter wiring; mark ponytail builtin. | M (backend) |
| GATE.5 | frontend | Cockpit skill-control API + SkillsPage controls (toggle / add→gate / delete non-builtin) WITH the §4d server-side safety boundary. | M |
| GATE.6 | frontend | Prove the boundary: tests that the API refuses guardrail-weakening / test-gate-bypass / `real_api_calls`-flip from the frontend. | S (the set≠effective proof) |

Dependency: GATE.4 → GATE.5 → GATE.6; GATE.1/2/3 independent. Whole epic ~6 small/medium
stories. **Could ship in two phases**: approvals first (cheap, immediate relief), frontend
skill mgmt second.

## 6. Honest conclusion (ponytail-restraint)
- **What simplifies (without touching a guardrail):** per-step build barriers (→ `/goal`
  more autonomous), all-policy gating (→ only guardrail-weakening), per-promotion clicks
  (→ pre-authorise), and the protect-user steps (→ silent auto). These are categories 2/3.
- **What stays exactly as-is:** every category-1 guardrail — exit gate, tool layer,
  isolation, additive/Observe, spec/regression gates, **skill test-gate**, **`real_api_calls`
  fail-closed**, no-self-grant/promote. The litmus каught the two most-likely
  mis-deletions: the skill test-gate and `real_api_calls` are **guardrails that protect
  the agent's controllability and the user's money — NOT user-decision blockers**.
- **Frontend skill management is modest**, not a marketplace: an `enabled`+`builtin`
  flag, a gated add, an instant toggle/delete, and a **server-enforced** cockpit safety
  boundary. ~3 frontend stories.
- **Cockpit read-only → control is safe** as long as §4d holds in code: the frontend may
  carry *user decisions and approvals*, never *guardrail relaxation*. Precedent already
  exists (routing PUT); the new rule is the explicit, enforced boundary.

Net: GateLoop becomes **"strict on the agent, smooth for the user"** — the same gates
that make it safe, with the approval friction the user dislikes removed where (and only
where) it was facing the user.

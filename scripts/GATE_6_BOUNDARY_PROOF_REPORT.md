# STORY-GATE.6 — §4d Boundary Proof (set ≠ effective)

GATE.5 **wrote** the cockpit §4d boundary; GATE.6 **proves it is enforced** — not "the
boundary is documented" but "the API actually refuses". Every boundary-crossing attempt
is a real adversarial request asserted REFUSED (403) by the server
(`handleSkillControl` → `decideSkillControl`; the Fastify endpoints are thin wrappers
over these), with the catalog left unmutated. `real_api_calls`: **false** throughout;
scripted/offline; zero cost. Test: `tests/gate6_boundary_proof.test.ts` (9 tests, all green).

---

## The four red lines — each crossed, each refused

### RED LINE 1 — weaken a guardrail → REFUSED
Adversarial requests asserted 403 + catalog unchanged:
- `{op:'toggle', …, allowed_write_set:['**']}` (loosen write-set) → refused
- `{op:'toggle', …, default_deny:false}` (disable default-deny) → refused
- `{op:'toggle', …, isolation:{network:true}}` (lower isolation) → refused
- `{op:'toggle', …, allowed_tools:['bash']}` (widen tools) → refused
- camelCase variants (`allowedTools`, `writeSet`) → refused (hardened regex)
- dedicated ops `weaken_writeset` / `disable_default_deny` → refused (not a permitted op)

### RED LINE 2 — bypass the test-gate → REFUSED
- `{op:'add', manifest:{… tests:[]}}` (no tests) → refused
- `{op:'add', manifest:{… status:'registered'}}` (self-register to skip the lifecycle) → refused
- `{op:'register'}` (no such op) → refused
- A *legitimate* add is **STAGED `needs_tests`, NEVER `registered`** — it must pass the
  lifecycle test-gate (skill-tester). Asserted `status==='needs_tests'`, `!=='registered'`.

### RED LINE 3 — open real_api_calls → REFUSED + stays false
- `{op:'enable_real_api_calls'}` → refused
- `{op:'toggle', …, real_api_calls:true}` and `realApiCalls:true` (camelCase) → refused
- `{op:'toggle', …, kill_switch:false}` → refused
- **Structural proof:** the real `configs/policy.yaml` is snapshotted before/after the
  whole real_api barrage and is **byte-identical**; `real_api_calls.enabled` is still
  `false` (fail-closed). The skill-control handler has no path to policy.yaml.

### RED LINE 4 — overreach / self-promote → REFUSED
- `{op:'promote'}`, `{op:'self_promote'}`, `{op:'promote_to_stable'}` → refused
- `{op:'exec', command:'rm -rf /'}`, `{op:'run_agent'}` → refused
- `{op:'toggle', …, promotion:'stable'}` → refused

## Smuggling fully generalised
For every smuggled guardrail field ∈ {real_api_calls, policy, allowed_write_set,
default_deny, isolation, allowed_tools, sudo, secret, promotion, container, network}
× every legal base op {toggle, delete}: the request is **refused (403, server-enforced,
catalog unmutated)**. The identical ops *without* the smuggled field **succeed (200)** —
proving it is the smuggled field that is refused, not the operation.

## The strongest guarantee — structural (can't touch, not just refused)
The handler's only IO is `{read(): SkillCatalog, write(SkillCatalog)}` — it can only ever
read/write the **skill catalog**. A spy-IO test asserts that across the whole barrage,
**every** persisted object has keys exactly `['skills']`, and **no** skill entry ever
carries a guardrail/policy/real_api key. There is no code path from skill control to
policy.yaml / real_api_calls / write-set / tool grants. Even a guardrail field that
slipped the regex would be **structurally inert** — the add-handler copies only
`skill_id/agent_role/path` into a fresh `needs_tests` entry; toggle sets only `enabled`;
delete only splices. Defense-in-depth (the regex 403) + structural impossibility.

## set ≠ effective — closed
- A refused request returns **403 AND leaves the catalog untouched** (asserted).
- An allowed request **mutates** the catalog (asserted).
- The boundary written in GATE.5 is therefore **enforced**, not merely documented.

## Validation
- `tests/gate6_boundary_proof.test.ts`: 9 adversarial tests, all green.
- skill-runtime + GATE.5 + GATE.6: 36 pass; root full suite **122 files, 1435 pass / 9
  skip**; typecheck 0. No agent guardrail file touched (the only GATE.6 source change was
  hardening the `OVERREACH_FIELD` regex for camelCase — strengthening, not weakening).
- `real_api_calls`: false; zero cost; outer repo, not pushed.

## EPIC-GATE — COMPLETE
- **Approval track (GATE.1-3):** /goal auto-advances within an epic (keeps trust-boundary
  / epic-done / budget / real_api_calls stops); protective backstops run silently (but stop
  on a real secret hit); policy gate only stops guardrail-weakening edits.
- **Frontend track (GATE.4-6):** skill-runtime has `enabled`+`builtin` (ponytail builtin,
  can-disable-cannot-delete); the cockpit can toggle / add-through-gate / delete-non-builtin;
  the §4d boundary is **server-enforced and now adversarially proven**.
- Every agent guardrail KEPT. GateLoop is now **strict on the agent, smooth for the user.**

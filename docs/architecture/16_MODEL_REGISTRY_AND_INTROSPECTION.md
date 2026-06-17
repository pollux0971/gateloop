# Model Registry, Agent Introspection & Structured Interfaces

**Status:** design baseline for EPIC-032 · **Layer:** product docs (architecture)
**Refactors:** EPIC-011 (provider), EPIC-018 (model ops), EPIC-025 (skills UI),
EPIC-024 (console / story-manager surface)

Four operator requests, each tightening a part of the system the live runs left rough:

1. Structured (JSON) agent-to-agent calls, with each callee's prompt documenting
   the envelope shapes it receives.
2. A static asset browser: view each agent's full (config-level) system prompt and
   each skill's complete contents — so a bad output can be diagnosed as
   prompt/skill authoring vs model capability.
3. Story Manager folded into the Pipeline Board; no standalone Story Manager nav.
4. Register **models**, not providers — each model self-named, with base_url and
   optional pricing/limits; agents pick a model by its self-chosen name. ACP CLI
   tools register on the same page, separated by a divider.

---

## 1. Structured agent envelopes (JSON, self-documenting)

The task packets (029.2/029.4) become formal JSON Schemas, and so do the agent
responses. Every cross-agent call is an envelope validated on both ends.

```
specs/agent_envelope/
  developer_task_packet.schema.json
  debugger_task_packet.schema.json
  assessment_request.schema.json
  review_request.schema.json
  patch_proposal.schema.json        (exists)
  diagnosis_report.schema.json      (exists)
  assessment_report.schema.json     (from EPIC-030)
```

Validation pipeline (in agent-core/askModel): `compose → ajv validate envelope →
send → receive → ajv validate response → reject+retry on malformed (attempt
budget)`. Reuses the fixture-provider malformed-rejection behaviour.

**Self-documenting prompts:** each agent's system prompt includes a section
describing the envelope types it receives, with per-field notes. This section is
**generated from the schema `description` fields**, never hand-written — so prompt
and schema can never drift. This is also the input to requirement 2's prompt view.

## 2. Static asset browser (config-level prompt + full skill contents)

Two read-only views. **Neither touches the trace; neither is an execution
snapshot.** They show the *assets as configured*, so the operator can judge
whether the instructions themselves are well-authored.

### 2a. Agent full system prompt (config-level composition)

The prompt is composed from: base template + the skills the agent mounts + the
envelope-format section (from §1). The browser shows the **config-level
composition** — "what this agent should look like given its configuration" — not
any single execution instance.

Critical correctness rule: the composition logic is a single pure function shared
by both the executor (askModel) and this read-only endpoint. They differ only in
input — the endpoint feeds *configuration representatives* (this agent mounts
these skills, receives these packet types), the executor feeds the live instance.
This guarantees **what you view is composed the same way as what the model
receives**, without being a trace snapshot.

```
GET /agents/{role}/prompt → { base, mounted_skills[], envelope_docs[], composed }
```

### 2b. Skill full contents

```
GET /skills/{id} → { metadata, skill_md (markdown), scripts[] (name + source) }
```
Reads the skill directory directly. Frontend renders three tabs: metadata /
markdown / scripts (syntax-highlighted).

### Diagnosis use

To distinguish "prompt/skill mis-authored" from "model too weak", the operator
reads the asset directly: open the agent's composed prompt and the skills it
uses, and judge whether the instructions are sound. Static, repeatable, no
dependence on any single run. (Deliberately decoupled from EPIC-031's trace_ref
pointers — that is a separate, execution-time mechanism.)

## 3. Story Manager folded into the Pipeline Board

Story Manager is a deterministic admission controller (EPIC-023), not a thing the
operator drives. Its *display* surface is exactly the Pipeline Board. So:

- The Pipeline Board (016.3) hosts the admission view: lanes (kanban), the
  dependency DAG, the wave schedule, and the admission-control panel (why a story
  cannot enter yet — dep unmet / hold / WIP full / write-set overlap).
- The standalone Story Manager nav entry is removed.
- EPIC-023 (the deterministic backend) is unchanged — only the UI is merged.
- The single operator action that remains (manual hold/release of a story) lives
  as a per-card control on the board, not a separate page.

## 4. Model-centric registry (replaces provider-centric)

The shift: from "register a provider, route by `provider/model`" to "register a
**named model** with its own properties, route by the self-chosen name."

### Model registry schema

```
specs/model_registry.schema.json — each entry:
  name:         string          # operator's own label, e.g. "my-cheap-coder"
  kind:         openai | openai_responses_codex | anthropic | cli   # cli = external CLI tool (§5)
  base_url:     string          # auto-filled per kind, or manual
  secret_handle: string         # credential via Secret Broker (never the value)
  pricing:                      # ALL OPTIONAL
    input?:        number       # $ / 1M tokens
    output?:       number
    cache_input?:  number
  limit?:         number        # rate limit (req/min) — optional, for scheduling
  cli?:          { driver: headless|acp, command, args[] }  # present only when kind = cli (see EPIC-033)
```

`configs/providers.yaml` → `configs/models.yaml` (model-centric). `model_routing.yaml`
maps each agent to a **model name**, not a `provider/model` string.

### Cost estimation (the real algorithm here)

With per-model pricing, the gateway computes live cost:
`run_cost = Σ_models ( input_tok × input_price + output_tok × output_price
                        − cached_tok × (input_price − cache_input_price) )`
This feeds the cost bar (demo v5) and the budget guard's `$5 → token cap`
conversion. **Pricing is optional**: a model with no pricing still counts tokens
but reports cost as "unknown" rather than guessing. `limit` feeds rate-limit
scheduling, not cost.

### Frontend (API page)

From "list of providers" to a **model registry table**: each row a named model
with its properties; an "add model" form with name + base_url (auto/manual) +
optional input/output/cache_input/limit. Agent routing dropdowns list the
self-chosen names. **ACP CLI tools register on the same page, below a divider**
(requirement: same page, separated by a line) — they fill a CLI path instead of a
base_url (kind = acp).

## What changes, in one table

| Area | Before | After |
| --- | --- | --- |
| config | providers.yaml (provider-centric) | models.yaml (named models) |
| routing | agent → provider/model string | agent → self-chosen model name |
| gateway | resolves provider | resolves model name |
| cost | post-hoc from trace | live, from per-model pricing |
| API UI | provider list | model table + add-model form (+ ACP below divider) |
| skills UI | name + gate status | + full metadata/markdown/scripts tabs |
| agent prompt | not viewable | config-level composed prompt, viewable |
| envelopes | structured packets (029) | formal JSON schemas + self-documenting prompts |
| Story Manager | (drawer/standalone) | folded into Pipeline Board; nav entry removed |

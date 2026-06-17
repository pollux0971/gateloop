# Model Provider Gateway

The Model Provider Gateway is the provider boundary between GateLoop agent
runtimes and the component that supplies structured agent output. It is a
deterministic harness component, not an agent.

In v20 the executable path is intentionally **no-key only**:

- `scripted` provider: deterministic in-memory cases, used by the walking skeleton.
- `fixture` provider: reads checked-in JSON agent outputs from a fixture root.
- `manual` provider: returns a structured clarification escalation placeholder.
- `llm_remote` provider: present only as a disabled provider until Secret Broker,
  network policy, timeout/retry, redaction, usage accounting, and human approval
  are implemented.

This gives the runtime a stable provider interface before real LLM calls are
allowed.

## Responsibilities

1. Receive a `ModelGatewayRequest` from Supervisor/Developer/Debugger runtime.
2. Route to one or more registered providers.
3. Normalize provider output into `DeveloperOutput` or `DebuggerOutput`.
4. Reject free-form prose or malformed JSON.
5. Return a `ProviderResult` containing output, validation errors, provider id,
   provider kind, and approximate usage.
6. Allow fallback across providers without exposing secrets.

## Non-responsibilities

The Model Provider Gateway does not:

- apply patches;
- execute tools;
- bypass Permission Gateway;
- fetch raw secrets into agent context;
- promote or merge;
- decide story completion;
- turn free-form prose into a patch by guessing.

## v20 Provider Contract

Every provider implements:

```ts
interface ModelProvider {
  id: string;
  kind: 'scripted' | 'fixture' | 'manual' | 'llm_remote';
  call(req: ModelGatewayRequest): Promise<unknown>;
}
```

The gateway then validates the returned object:

```text
provider raw output
  ↓
validateDeveloperResponse / validateDebuggerResponse
  ↓
valid AgentOutput union or rejected ProviderResult
```

A provider may not return arbitrary text as the final output. If the model or
operator needs clarification, it must return a structured escalation.

## Scripted Provider

Used for deterministic tests and the walking skeleton. It maps a request to a
pre-registered case:

```text
story_id + target_agent + task_class → AgentOutput
```

If no case matches, it returns a structured `blocked_report` instead of guessing.

## Fixture Provider

Reads `${fixture_id}.json` from a fixed fixture root. Path traversal outside the
fixture root is rejected. The loaded JSON must still pass AgentOutput validation.

## Manual Provider

Used for early semi-automatic runs. It returns a structured clarification request
asking the human to paste a validated AgentOutput JSON or choose another provider.

## Disabled Remote Provider

`llm_remote` is intentionally disabled in v20. Enabling it later requires:

- Secret Broker handle;
- network policy grant;
- timeout and retry policy;
- redaction before trace logging;
- token usage accounting;
- first-enable human gate.

## Walking Skeleton Integration

`npm run walk` now uses `@gateloop/model-gateway` with a no-key scripted
Developer provider. The walking skeleton no longer has a hard-coded Developer
inside the script; the script requests a Developer patch proposal through the
provider boundary, then continues through:

```text
provider output validation
  ↓
spec-conformance hard gate
  ↓
Permission Gateway
  ↓
Tool Executor git apply
  ↓
Validator verdict
  ↓
CHECKPOINT transition
```

## Security Invariants

- Provider output is proposal content only; it cannot execute tools.
- Provider output must be structured; malformed output is rejected.
- Remote LLM providers are disabled until the full secret/network policy exists.
- `manual` provider does not silently continue; it emits escalation.
- `scripted` unmatched cases emit escalation instead of hallucinating.

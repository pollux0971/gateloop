/**
 * @gateloop/agent-core — askModel
 *
 * The single shared call path every agent runtime uses to reach the model
 * gateway. Before this wire existed, none of the four agent runtimes imported
 * model-gateway, so nothing ever sent a prompt (Diagnosis item 3, STORY-029.1).
 *
 * askModel(input, deps):
 *   1. selects the provider route via model_routing.yaml (config-driven, the
 *      agent never picks its own backend — see gateloop/CLAUDE.md);
 *   2. builds a ModelGatewayRequest from the task packet;
 *   3. calls the gateway with first-valid fallback;
 *   4. applies the SAME malformed-output rejection as the fixture/scripted
 *      providers — a structurally invalid response is surfaced as ok:false,
 *      never returned as if it were a real agent output.
 *
 * It works end-to-end with the scripted provider, so the whole cognition chain
 * is testable with no LLM and no network.
 */
import {
  ProviderRegistry,
  resolveProviderIdsFromConfig,
  parseModelRef,
  callFirstValid,
  type AgentRole,
  type TaskClass,
  type RoutingConfig,
  type ModelGatewayRequest,
  type ProviderResult,
  type AgentStructuredOutput,
  type ProviderKind,
  type ProviderUsage,
} from '@gateloop/model-gateway';
import { validateEnvelope } from './envelope.ts';
import { envelopeDocsForRole } from './envelopeDocs.ts';
import { composeSystemPrompt, type MountedSkill } from './composeSystemPrompt.ts';

/** Injected collaborators. Both are plain data/config — no secrets, no network.
 *  Dependency-injected so every call site (and every test) is deterministic and
 *  CI-safe. */
export interface AskModelDeps {
  /** Registry of provider adapters. In CI this holds scripted/fixture providers
   *  only; live adapters are registered solely when the real_api_calls gate is on. */
  registry: ProviderRegistry;
  /** Parsed model_routing.yaml (config-driven backend selection). */
  routing: RoutingConfig;
}

/** One agent's request for model cognition, framed as a task packet. */
export interface AskModelInput {
  /** Which agent is asking — drives routing selection. */
  role: AgentRole;
  /** The composed task packet handed to the model (objective, write-set, etc.). */
  taskPacket: Record<string, unknown>;
  /** Task class for routing task_overrides; defaults to 'generic'. */
  taskClass?: TaskClass;
  /** Story under work, for trace correlation and scripted-case matching. */
  storyId?: string;
  /** Optional explicit request id; otherwise derived deterministically. */
  requestId?: string;
  /** Fixture id, only used when routed to a fixture provider. */
  fixtureId?: string;
  /**
   * STORY-032.1: opt-in JSON envelope validation. When `request` is set, the
   * taskPacket is validated against that envelope schema on compose and a malformed
   * envelope is rejected (ok:false) before any provider is called — the caller
   * retries within its attempt budget. When `response` is set, the returned output
   * is validated against that envelope (reusing the fixture malformed-rejection).
   * Omitted by default → behaviour is unchanged for existing callers.
   */
  envelope?: { request?: string; response?: string };
  /**
   * STORY-032.3: prompt-composition input for the executor. When provided, askModel
   * composes the system prompt via the SHARED composeSystemPrompt function (the same
   * one the introspection endpoint uses) — base + mounted skills + the role's
   * envelope docs — and sends it with the request. Omitted → no system prompt is composed.
   */
  prompt?: { base: string; mountedSkills?: MountedSkill[] };
}

/** The structured response. `ok` is true only when a routed provider returned a
 *  response that passed structured-output validation. */
export interface AskModelResponse {
  ok: boolean;
  /** Validated agent output, present only when ok. */
  output?: AgentStructuredOutput;
  provider_id: string;
  provider_kind: ProviderKind;
  errors: string[];
  usage: ProviderUsage;
  /** The provider ids the route resolved to (intended order), for trace evidence. */
  routed_provider_ids: string[];
  /** STORY-032.1: response-envelope schema conformance (advisory) when an
   *  `envelope.response` was named; undefined when not requested. */
  response_envelope_valid?: boolean;
  /** STORY-032.3: the system prompt composed (via the shared composeSystemPrompt)
   *  and sent with this request; undefined when no `prompt` input was given. */
  composed_system_prompt?: string;
}

/** Map model_routing refs (`provider/model`) down to bare provider ids, preserving
 *  order and dropping duplicates. A bare id (no `/`) is passed through unchanged. */
function toProviderIds(refs: string[]): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    const parsed = parseModelRef(ref);
    const id = parsed ? parsed.provider_id : ref;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export async function askModel(input: AskModelInput, deps: AskModelDeps): Promise<AskModelResponse> {
  const taskClass: TaskClass = input.taskClass ?? 'generic';

  // STORY-032.1: validate the request envelope on compose (opt-in). A malformed
  // envelope is rejected before any provider is called; the caller retries within
  // its attempt budget. Same rejection shape as a malformed response.
  if (input.envelope?.request) {
    const v = validateEnvelope(input.taskPacket, input.envelope.request);
    if (!v.ok) {
      return {
        ok: false,
        provider_id: '',
        provider_kind: 'scripted',
        errors: [`malformed request envelope (${input.envelope.request}): ${v.errors.join('; ')}`],
        usage: { inputTokens: 0, outputTokens: 0 },
        routed_provider_ids: [],
      };
    }
  }

  const routedProviderIds = toProviderIds(
    resolveProviderIdsFromConfig(deps.routing, input.role, taskClass),
  );

  if (routedProviderIds.length === 0) {
    return {
      ok: false,
      provider_id: '',
      provider_kind: 'scripted',
      errors: [`no route configured for role ${input.role} / task ${taskClass}`],
      usage: { inputTokens: 0, outputTokens: 0 },
      routed_provider_ids: [],
    };
  }

  // Fail closed: only call providers whose adapter is actually registered.
  // Routing to an unregistered provider must not crash at call time — it returns
  // a clear, human-facing error instead (mirrors validateRoutingRegistered).
  const callable = routedProviderIds.filter((id) => deps.registry.has(id));
  if (callable.length === 0) {
    return {
      ok: false,
      provider_id: routedProviderIds.join(','),
      provider_kind: 'scripted',
      errors: [
        `no registered provider for route [${routedProviderIds.join(', ')}]; fail closed — ` +
          `register the adapter (real_api_calls bootstrap) or correct model_routing.yaml`,
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      routed_provider_ids: routedProviderIds,
    };
  }

  // STORY-032.3: compose the system prompt via the SHARED pure function (the same
  // one the introspection endpoint uses), and send it with the request.
  const composed_system_prompt = input.prompt
    ? composeSystemPrompt(input.prompt.base, input.prompt.mountedSkills ?? [], envelopeDocsForRole(input.role))
    : undefined;

  const req: ModelGatewayRequest = {
    request_id: input.requestId ?? `askmodel-${input.role}-${taskClass}-${input.storyId ?? 'no-story'}`,
    target_agent: input.role,
    task_class: taskClass,
    story_id: input.storyId,
    task_packet: composed_system_prompt !== undefined
      ? { ...input.taskPacket, system_prompt: composed_system_prompt }
      : input.taskPacket,
    fixture_id: input.fixtureId,
  };

  const result: ProviderResult = await callFirstValid(deps.registry, callable, req);

  // STORY-032.1: the hard response gate is callFirstValid's structured-output
  // rejection (reusing the fixture malformed-rejection). When a response envelope
  // is named, additionally check schema conformance and REPORT it — advisory, so a
  // structurally-valid output is never rejected merely for omitting optional fields.
  let response_envelope_valid: boolean | undefined;
  let envelopeErrors: string[] = [];
  if (input.envelope?.response && result.ok && result.output) {
    const v = validateEnvelope(result.output, input.envelope.response);
    response_envelope_valid = v.ok;
    if (!v.ok) envelopeErrors = v.errors.map(e => `response envelope advisory (${input.envelope!.response}): ${e}`);
  }

  return {
    ok: result.ok,
    output: result.output,
    provider_id: result.provider_id,
    provider_kind: result.provider_kind,
    errors: [...result.errors, ...envelopeErrors],
    usage: result.usage,
    routed_provider_ids: routedProviderIds,
    response_envelope_valid,
    composed_system_prompt,
  };
}

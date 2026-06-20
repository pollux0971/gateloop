/**
 * Metered-key backends — the CORE, product-default, distributable path (EPIC-035 / STORY-035.2).
 *
 * Standard OpenAI/Anthropic API keys, resolved through the Secret Broker AT THE CALL BOUNDARY
 * (plaintext exists only inside the engine-build closure here — never returned to the driver or
 * the core). Officially supported, no ToS risk. The subscription path (035.6) is a separate,
 * detachable plugin; the metered core does NOT import it.
 */
import { SecretBroker, meteredKeyHandle, type SecretHandle } from '@gateloop/secret-broker';
import type { LanguageModelEngine } from '../engine';
import { createAiSdkEngine, type AiSdkStreamText } from '../aiSdkEngine';

export interface MeteredBackendSpec {
  /** Concrete backend id, also the AgentEvent backend tag. */
  backendId: string;
  /** Secret Broker provider key → resolves `<PROVIDER>_API_KEY`. */
  keyProvider: string;
  /** Default model if the router does not pin one. */
  defaultModel: string;
}

/** The shipped metered backends. The router (model-gateway) selects which one + which model. */
export const METERED_BACKENDS: Record<string, MeteredBackendSpec> = {
  openai: { backendId: 'openai', keyProvider: 'openai', defaultModel: 'gpt-5.4' },
  anthropic: { backendId: 'anthropic', keyProvider: 'anthropic', defaultModel: 'claude-sonnet-4-6' },
};

export function pickMeteredBackend(backendId: string): MeteredBackendSpec {
  const spec = METERED_BACKENDS[backendId];
  if (!spec) throw new Error(`unknown metered backend '${backendId}' (have: ${Object.keys(METERED_BACKENDS).join(', ')})`);
  return spec;
}

/** The opaque handle the broker dereferences for this backend's metered key. */
export function meteredHandleFor(spec: MeteredBackendSpec): SecretHandle {
  return meteredKeyHandle(spec.keyProvider);
}

/**
 * Resolve the metered key via the broker. The ONLY place the key plaintext is produced for a
 * metered backend; callers must keep it inside the call boundary (see createMeteredEngine).
 */
export async function resolveMeteredKey(broker: SecretBroker, spec: MeteredBackendSpec): Promise<string> {
  return broker.resolve(meteredHandleFor(spec));
}

export interface MeteredEngineDeps {
  spec: MeteredBackendSpec;
  /** Model id (router-picked); defaults to the backend's defaultModel. */
  model?: string;
  broker: SecretBroker;
  /** AI SDK `streamText`, injected (the SDK is never imported in this package). */
  streamText: AiSdkStreamText;
  /** apiKey + modelId → AI SDK model instance, e.g. (k, m) => createOpenAI({ apiKey: k })(m). Injected. */
  modelFactory: (apiKey: string, modelId: string) => unknown;
}

/**
 * Build a metered LanguageModelEngine. The key is resolved through the broker INSIDE this
 * closure and handed only to the injected `modelFactory` (which constructs the AI SDK model);
 * it is never returned, logged, or seen by the driver/core. No real call happens here — that is
 * the gated run (035.5) when a real `streamText`/`modelFactory` are supplied.
 */
export async function createMeteredEngine(deps: MeteredEngineDeps): Promise<LanguageModelEngine> {
  const modelId = deps.model ?? deps.spec.defaultModel;
  const apiKey = await resolveMeteredKey(deps.broker, deps.spec); // plaintext lives ONLY in this scope
  if (!apiKey) {
    throw new Error(`no metered key for backend '${deps.spec.backendId}' (broker provider '${deps.spec.keyProvider}')`);
  }
  const modelInstance = deps.modelFactory(apiKey, modelId);
  return createAiSdkEngine({ backendId: deps.spec.backendId, model: modelId, streamText: deps.streamText, modelInstance });
}

/**
 * @gateloop/provider-driver — in-process multi-backend provider layer (EPIC-035, per ADR-020).
 *
 * Replaces spawn-CLI delegation: a ProviderDriver drives a backend IN-PROCESS via the Vercel AI
 * SDK, behind the inherited ExternalAgentDriver/DiffProducer seam. The AI SDK is isolated inside
 * this package (engine.ts membrane + aiSdkEngine.ts injected boundary) — the core never imports
 * `ai`/`@ai-sdk/*`. This index re-exports ONLY the driver + neutral types; it never re-exports
 * the AI SDK.
 */
export type {
  EngineUsage,
  EngineStreamPart,
  EngineTool,
  EngineRunInput,
  LanguageModelEngine,
} from './engine';

export {
  mapEnginePartToAgentEvent,
  backendToCliKind,
} from './aiSdkAdapter';

export {
  createAiSdkEngine,
  normalizeAiSdkPart,
  type AiSdkStreamPart,
  type AiSdkStreamResult,
  type AiSdkStreamText,
  type AiSdkEngineDeps,
} from './aiSdkEngine';

export {
  createScriptedEngine,
  scriptedToolRun,
  type ScriptedEngineOptions,
} from './scriptedEngine';

export {
  METERED_BACKENDS,
  pickMeteredBackend,
  meteredHandleFor,
  resolveMeteredKey,
  createMeteredEngine,
  type MeteredBackendSpec,
  type MeteredEngineDeps,
} from './backends/metered';

export {
  ProviderDriver,
  type ProviderRunner,
  type ProviderDriverOptions,
  type ProviderToolMediator,
  type ToolCall,
  type ToolMediation,
  type ToolMediationStage,
  type StopVerdict,
} from './providerDriver';

export {
  ConfinedToolMediator,
  codegraphBackendFromClient,
  surfacePermission,
  isWhitelistedTool,
  makeValidatingPreHook,
  makeRedactPostHook,
  requireReportStopHook,
  deepRedact,
  type PermissionVerdict,
  type ToolPermission,
  type PreToolUseHook,
  type PreToolUseHookInput,
  type PreToolUseHookResult,
  type PostToolUseHook,
  type PostToolUseHookInput,
  type PostToolUseHookResult,
  type StopHook,
  type StopHookInput,
  type ConfinedMediatorOptions,
  type ToolAuditRecord,
} from './confinement';

export {
  assertToolLayerConfinementBarrier,
  FAKE_PLANTED_SECRET,
  type ConfinementInvariant,
  type ConfinementBarrierResult,
} from './confinementProof';

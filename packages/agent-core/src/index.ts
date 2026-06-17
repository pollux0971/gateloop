/**
 * @gateloop/agent-core
 *
 * Shared cognition primitives every agent runtime imports. The first and most
 * foundational is askModel — the agent→gateway call path (STORY-029.1). Every
 * runtime (Supervisor, Developer, Debugger) reaches the model through here, so
 * backend selection stays config-driven and malformed output is rejected once,
 * in one place.
 */
export {
  askModel,
  type AskModelDeps,
  type AskModelInput,
  type AskModelResponse,
} from './askModel.ts';

export {
  validateAgainstSchema,
  validateEnvelope,
  loadEnvelopeSchema,
  requestEnvelopeForRole,
  responseEnvelopeForRole,
  allRequestEnvelopeNames,
  REQUEST_ENVELOPE_BY_ROLE,
  RESPONSE_ENVELOPE_BY_ROLE,
  type SchemaValidationResult,
  type JsonSchema,
} from './envelope.ts';

export {
  generateEnvelopeDoc,
  renderEnvelopeDoc,
  envelopeDocsForRole,
  envelopeDocsAreFresh,
  type EnvelopeDoc,
  type EnvelopeFieldDoc,
} from './envelopeDocs.ts';

export {
  composeSystemPrompt,
  type MountedSkill,
} from './composeSystemPrompt.ts';

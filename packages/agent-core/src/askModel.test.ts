import { describe, it, expect } from 'vitest';
import {
  ProviderRegistry,
  createScriptedProvider,
  type RoutingConfig,
  type AgentStructuredOutput,
  type ScriptedCase,
} from '@gateloop/model-gateway';
import { askModel, type AskModelDeps } from './askModel.ts';
import { VALID_DEV_PACKET } from './envelope.test.ts';
import { composeSystemPrompt } from './composeSystemPrompt.ts';
import { envelopeDocsForRole } from './envelopeDocs.ts';

// A structurally valid Developer patch proposal (proposal_id + story_id + non-empty changed_files).
const VALID_PATCH: AgentStructuredOutput = {
  kind: 'patch_proposal',
  proposal_id: 'prop-029-1',
  story_id: 'STORY-029.1',
  changed_files: ['gateloop/packages/agent-core/src/askModel.ts'],
} as AgentStructuredOutput;

// Same kind, but missing the required fields → must be rejected exactly like a fixture would.
const MALFORMED_PATCH = { kind: 'patch_proposal' } as AgentStructuredOutput;

function devCase(output: AgentStructuredOutput): ScriptedCase {
  return { case_id: 'dev', match: { target_agent: 'developer' }, output };
}

function depsWith(
  providers: Record<string, AgentStructuredOutput>,
  routing: RoutingConfig,
): AskModelDeps {
  const registry = new ProviderRegistry();
  for (const [id, output] of Object.entries(providers)) {
    registry.register(createScriptedProvider(id, [devCase(output)]));
  }
  return { registry, routing };
}

const ROUTING_PRIMARY: RoutingConfig = {
  agents: { developer: { primary: 'scripted-dev', fallbacks: ['scripted-fallback'] } },
};

describe('STORY-029.1 askModel — agent→gateway call interface', () => {
  it('askModel_interface_defined: returns a structured response with the documented shape', async () => {
    const deps = depsWith({ 'scripted-dev': VALID_PATCH }, ROUTING_PRIMARY);
    const res = await askModel({ role: 'developer', taskPacket: { objective: 'x' }, storyId: 'STORY-029.1' }, deps);

    expect(typeof askModel).toBe('function');
    expect(res).toHaveProperty('ok');
    expect(res).toHaveProperty('output');
    expect(res).toHaveProperty('provider_id');
    expect(res).toHaveProperty('provider_kind');
    expect(res).toHaveProperty('errors');
    expect(res).toHaveProperty('usage');
    expect(res).toHaveProperty('routed_provider_ids');
    expect(Array.isArray(res.errors)).toBe(true);
  });

  it('selects_provider_via_routing: routes to the configured primary and records the route order', async () => {
    const deps = depsWith(
      { 'scripted-dev': VALID_PATCH, 'scripted-fallback': VALID_PATCH },
      ROUTING_PRIMARY,
    );
    const res = await askModel({ role: 'developer', taskPacket: {}, storyId: 'STORY-029.1' }, deps);

    expect(res.ok).toBe(true);
    expect(res.provider_id).toBe('scripted-dev'); // primary, not fallback
    expect(res.routed_provider_ids).toEqual(['scripted-dev', 'scripted-fallback']);
  });

  it('selects_provider_via_routing: task_overrides redirect a task class to a different provider', async () => {
    const routing: RoutingConfig = {
      agents: { developer: { primary: 'scripted-dev', fallbacks: ['scripted-fallback'] } },
      task_overrides: { patch_generation: { developer: 'scripted-override' } },
    };
    const deps = depsWith(
      { 'scripted-dev': VALID_PATCH, 'scripted-fallback': VALID_PATCH, 'scripted-override': VALID_PATCH },
      routing,
    );
    const res = await askModel(
      { role: 'developer', taskClass: 'patch_generation', taskPacket: {}, storyId: 'STORY-029.1' },
      deps,
    );

    expect(res.ok).toBe(true);
    expect(res.provider_id).toBe('scripted-override');
    expect(res.routed_provider_ids).toEqual(['scripted-override']);
  });

  it('selects_provider_via_routing: maps provider/model refs down to the bare provider id', async () => {
    const routing: RoutingConfig = {
      agents: { developer: { primary: 'codex/gpt-5.5-codex', fallbacks: ['deepseek/deepseek-v4-pro'] } },
    };
    const deps = depsWith({ codex: VALID_PATCH, deepseek: VALID_PATCH }, routing);
    const res = await askModel({ role: 'developer', taskPacket: {}, storyId: 'STORY-029.1' }, deps);

    expect(res.ok).toBe(true);
    expect(res.provider_id).toBe('codex');
    expect(res.routed_provider_ids).toEqual(['codex', 'deepseek']);
  });

  it('malformed_output_rejected: a structurally invalid response is surfaced as ok:false, not returned as output', async () => {
    const deps = depsWith({ 'scripted-dev': MALFORMED_PATCH, 'scripted-fallback': MALFORMED_PATCH }, ROUTING_PRIMARY);
    const res = await askModel({ role: 'developer', taskPacket: {}, storyId: 'STORY-029.1' }, deps);

    expect(res.ok).toBe(false);
    expect(res.output).toBeUndefined();
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.join(' ')).toContain('proposal'); // shallowProposalErrors fired
  });

  it('works_with_scripted_provider_no_llm: returns a validated agent output with no network/LLM', async () => {
    const deps = depsWith({ 'scripted-dev': VALID_PATCH }, ROUTING_PRIMARY);
    const res = await askModel({ role: 'developer', taskPacket: { objective: 'add x' }, storyId: 'STORY-029.1' }, deps);

    expect(res.ok).toBe(true);
    expect(res.provider_kind).toBe('scripted');
    expect(res.output?.kind).toBe('patch_proposal');
    expect((res.output as Record<string, unknown>).proposal_id).toBe('prop-029-1');
  });

  it('fail-closed: routing to an unregistered provider returns a clear error instead of crashing', async () => {
    const registry = new ProviderRegistry(); // nothing registered
    const res = await askModel(
      { role: 'developer', taskPacket: {}, storyId: 'STORY-029.1' },
      { registry, routing: ROUTING_PRIMARY },
    );

    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('fail closed');
    expect(res.routed_provider_ids).toEqual(['scripted-dev', 'scripted-fallback']);
  });

  it('no route: an unrouted role returns ok:false with an explanatory error', async () => {
    const deps = depsWith({ 'scripted-dev': VALID_PATCH }, { agents: {} });
    const res = await askModel({ role: 'supervisor', taskPacket: {}, storyId: 'STORY-029.1' }, deps);

    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('no route configured');
  });
});

// ── STORY-032.1: JSON envelope validation on compose and response ──────────────

describe('STORY-032.1 envelope validation in askModel', () => {
  it('envelopes_validated_on_compose_and_response: valid envelope routes, output validated', async () => {
    const deps = depsWith({ 'scripted-dev': VALID_PATCH }, ROUTING_PRIMARY);
    const res = await askModel(
      { role: 'developer', taskPacket: VALID_DEV_PACKET, storyId: 'STORY-042.1',
        envelope: { request: 'developer_task_packet', response: 'patch_proposal' } },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.output?.kind).toBe('patch_proposal');
    // response envelope was validated (advisory) — a boolean is reported
    expect(typeof res.response_envelope_valid).toBe('boolean');
  });

  it('malformed_envelope_rejected_and_retried: malformed request rejected pre-send, retry with valid passes', async () => {
    const deps = depsWith({ 'scripted-dev': VALID_PATCH }, ROUTING_PRIMARY);
    // attempt 1: malformed request envelope ({} is missing all required fields)
    const bad = await askModel(
      { role: 'developer', taskPacket: {}, storyId: 'STORY-042.1', envelope: { request: 'developer_task_packet' } },
      deps,
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toContain('malformed request envelope');
    expect(bad.routed_provider_ids).toEqual([]); // rejected before any provider call
    // attempt 2 (retry): valid envelope succeeds
    const good = await askModel(
      { role: 'developer', taskPacket: VALID_DEV_PACKET, storyId: 'STORY-042.1', envelope: { request: 'developer_task_packet' } },
      deps,
    );
    expect(good.ok).toBe(true);
  });

  it('reuses_fixture_malformed_rejection: a malformed response is rejected even with a response envelope', async () => {
    const deps = depsWith({ 'scripted-dev': MALFORMED_PATCH, 'scripted-fallback': MALFORMED_PATCH }, ROUTING_PRIMARY);
    const res = await askModel(
      { role: 'developer', taskPacket: VALID_DEV_PACKET, storyId: 'STORY-042.1',
        envelope: { request: 'developer_task_packet', response: 'patch_proposal' } },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toBeUndefined();
  });

  it('no envelope option → behaviour unchanged (existing callers unaffected)', async () => {
    const deps = depsWith({ 'scripted-dev': VALID_PATCH }, ROUTING_PRIMARY);
    const res = await askModel({ role: 'developer', taskPacket: {}, storyId: 'STORY-029.1' }, deps);
    expect(res.ok).toBe(true); // empty packet still fine without envelope validation
  });

  // STORY-032.3 — executor uses the shared composeSystemPrompt function
  it('executor_uses_it: askModel composes the system prompt via the shared function', async () => {
    const deps = depsWith({ 'scripted-dev': VALID_PATCH }, ROUTING_PRIMARY);
    const base = 'You are the Developer.';
    const mountedSkills = [{ name: 'rest-api-template' }];
    const res = await askModel(
      { role: 'developer', taskPacket: {}, storyId: 'STORY-029.1', prompt: { base, mountedSkills } },
      deps,
    );
    // the prompt askModel sent equals the shared function's output for the same inputs
    expect(res.composed_system_prompt).toBe(
      composeSystemPrompt(base, mountedSkills, envelopeDocsForRole('developer')),
    );
    // and no prompt input → no composed prompt
    const none = await askModel({ role: 'developer', taskPacket: {}, storyId: 'X' }, deps);
    expect(none.composed_system_prompt).toBeUndefined();
  });
});

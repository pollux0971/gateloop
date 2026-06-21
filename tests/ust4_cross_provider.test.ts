/**
 * STORY-UST.4 WORK 3 — backend-agnostic: the unified skill/tool layer is identical
 * across a provider swap. This is the real meaning of "unified" — the registries sit
 * ABOVE provider-driver, so whichever backend executes a role gets the same skills,
 * the same tool gate, and the same codegraph toggle.
 *
 *   - Skills: the same mounted SKILL.md body reaches the composed prompt regardless of
 *     which provider the route resolves to (composition is provider-independent).
 *   - Tools: the per-role grant + the codegraph toggle + permission gating are decided
 *     by the tool layer, not the provider — identical across providers.
 *
 * Offline/scripted; real_api_calls untouched.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { askModel, composeSystemPrompt, type MountedSkill } from '@gateloop/agent-core';
import { loadMountedSkillsForRole } from '@gateloop/skill-runtime';
import { developerSystemPromptBase } from '@gateloop/developer-runtime';
import {
  ProviderRegistry, createScriptedProvider,
  type RoutingConfig, type AgentStructuredOutput,
} from '@gateloop/model-gateway';
import { ToolInterface, defaultHighLevelTools, type ToolGrants, type CodegraphBackend } from '@gateloop/tool-interface';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const VALID = {
  kind: 'patch_proposal', proposal_id: 'x', story_id: 'S', summary: 's', change_type: 'new_impl',
  changed_files: ['a.ts'], edits: [{ path: 'a.ts', operation: 'create' }], rollback_notes: 'rb',
} as AgentStructuredOutput;

function depsFor(providerId: string): { registry: ProviderRegistry; routing: RoutingConfig } {
  const registry = new ProviderRegistry();
  registry.register(createScriptedProvider(providerId, [{ case_id: 'c', match: { target_agent: 'developer' }, output: VALID }]));
  return { registry, routing: { agents: { developer: { primary: providerId } } } };
}

describe('STORY-UST.4 WORK 3 — skills are identical across a provider swap', () => {
  it('the same SKILL.md body reaches the composed prompt under provider A and provider B', async () => {
    const mountedSkills: MountedSkill[] = loadMountedSkillsForRole('developer', repoRoot)
      .map(s => ({ name: s.name, summary: s.summary, body: s.body, avoid: s.avoid }));
    const prompt = { base: developerSystemPromptBase(), mountedSkills };

    const a = await askModel({ role: 'developer', taskClass: 'patch_generation', taskPacket: {}, prompt }, depsFor('provider-a'));
    const b = await askModel({ role: 'developer', taskClass: 'patch_generation', taskPacket: {}, prompt }, depsFor('provider-b'));

    expect(a.provider_id).toBe('provider-a');
    expect(b.provider_id).toBe('provider-b');
    // different backends, byte-identical composed system prompt (skills live above the provider)
    expect(a.composed_system_prompt).toBe(b.composed_system_prompt);
    expect(a.composed_system_prompt).toContain('## Skill procedures');
    expect(a.composed_system_prompt).toContain('minimum code that works'); // ponytail body present under both
  });
});

describe('STORY-UST.4 WORK 3 — tool gate + codegraph toggle are provider-independent', () => {
  const grants: ToolGrants = {
    version: 1,
    roles: { developer: { allowed_tools: ['read_relevant_files', 'run_targeted_tests', 'query_codegraph'] } },
  };
  const codegraph: CodegraphBackend = { query: () => ({ summary: 'ok' }) };

  it('same per-role tools + codegraph permission-gating regardless of provider', () => {
    // The tool layer takes NO provider input — that IS the backend-agnostic property.
    const ti = new ToolInterface(defaultHighLevelTools({ codegraph }), grants);
    expect(ti.toolsForRole('developer').map(t => t.name)).toContain('query_codegraph');
    expect(ti.isAllowed('developer', 'query_codegraph').allowed).toBe(true);
    // a role without the grant is denied (permission-gated, not provider-decided)
    expect(ti.isAllowed('planning_steward', 'query_codegraph').allowed).toBe(false);
  });

  it('codegraph is toggleable (scale-relevant) and the toggle holds across providers', () => {
    const ti = new ToolInterface(defaultHighLevelTools({ codegraph }), grants);
    expect(ti.isAllowed('developer', 'query_codegraph').allowed).toBe(true);
    ti.setEnabled('query_codegraph', false);            // disable on a small project
    expect(ti.isAllowed('developer', 'query_codegraph').allowed).toBe(false);
    expect(ti.get('query_codegraph')?.scale_relevant).toBe(true);
  });
});

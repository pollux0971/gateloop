/**
 * STORY-GATE.5 — cockpit skill-control handler + §4d server-enforced boundary.
 * IO is injected (in-memory catalog); no HTTP, no fs. Adversarial cases assert the
 * server REFUSES overreach regardless of what the UI sends.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { handleSkillControl, type SkillCatalog } from '../apps/api/src/skillControl';

function makeCatalog(): SkillCatalog {
  return { skills: [
    { skill_id: 'developer.ponytail-lazy', agent_role: 'developer', path: 'skills/developer/ponytail-lazy', status: 'registered', enabled: true, builtin: true },
    { skill_id: 'developer.custom', agent_role: 'developer', path: 'skills/developer/custom', status: 'registered', enabled: true, builtin: false },
  ] };
}
let cat: SkillCatalog;
const io = { read: () => cat, write: (c: SkillCatalog) => { cat = c; } };
beforeEach(() => { cat = makeCatalog(); });

describe('STORY-GATE.5 skill control — user decisions (allowed)', () => {
  it('cockpit_api_ui_toggle_skill_enabled (un-gated)', () => {
    const r = handleSkillControl({ op: 'toggle', skill_id: 'developer.custom', enabled: false }, io);
    expect(r.code).toBe(200);
    expect(cat.skills.find(s => s.skill_id === 'developer.custom')!.enabled).toBe(false);
    // a builtin can also be DISABLED (can-disable-cannot-delete)
    expect(handleSkillControl({ op: 'toggle', skill_id: 'developer.ponytail-lazy', enabled: false }, io).code).toBe(200);
  });

  it('cockpit_delete_non_builtin_skill', () => {
    const r = handleSkillControl({ op: 'delete', skill_id: 'developer.custom' }, io);
    expect(r.code).toBe(200);
    expect(cat.skills.find(s => s.skill_id === 'developer.custom')).toBeUndefined();
  });

  it('cockpit_add_skill_registered_active_unvalidated (STORY-TRUST.6: test-gate dead on the API path)', () => {
    // ADR-0013: an add is PERMITTED with no test requirement AND registered ACTIVE — apps/api
    // no longer stamps `needs_tests` (which would bench it via selectSkillsForRole). The skill
    // is usable immediately, unvalidated (operator-trust); tests are an optional self-check.
    const r = handleSkillControl({ op: 'add', manifest: { skill_id: 'developer.new', agent_role: 'developer', path: 'skills/developer/new', tests: [] } }, io);
    expect(r.code).toBe(200);                    // permitted even without tests
    const added = cat.skills.find(s => s.skill_id === 'developer.new');
    expect(added).toBeDefined();
    expect(added!.status).toBe('registered');    // active, not benched as needs_tests
    expect(JSON.stringify(r.body)).not.toMatch(/needs_tests|must pass the lifecycle test-gate/);
  });
});

describe('STORY-GATE.5 §4d boundary — server REFUSES overreach (not UI politeness)', () => {
  it('cockpit_disable_builtin_not_delete — delete builtin refused', () => {
    const r = handleSkillControl({ op: 'delete', skill_id: 'developer.ponytail-lazy' }, io);
    expect(r.code).toBe(403);
    expect((r.body as any).error).toMatch(/builtin.*cannot be deleted|disable it instead/);
    expect(cat.skills.find(s => s.skill_id === 'developer.ponytail-lazy')).toBeDefined(); // still there
  });

  it('server_rejects_weaken_guardrail_or_enable_real_api_calls', () => {
    // STORY-TRUST.1 (ADR-0013): the test-gate is RETIRED — an add WITHOUT tests, and an add
    // that self-registers, are now PERMITTED (operator-trust), not refused. The refusals
    // below are NOT the test-gate: they keep the cockpit from reaching policy / real_api /
    // promotion (real_api stays human-only) — those guardrails STAY.
    expect(handleSkillControl({ op: 'add', manifest: { skill_id: 'x', agent_role: 'developer', path: 'p', tests: [] } as any }, io).code).toBe(200);
    expect(handleSkillControl({ op: 'add', manifest: { skill_id: 'y', agent_role: 'developer', path: 'p', tests: ['t'], status: 'registered' } as any }, io).code).toBe(200);
    // overreaching op → refused
    expect(handleSkillControl({ op: 'enable_real_api_calls' } as any, io).code).toBe(403);
    expect(handleSkillControl({ op: 'register' } as any, io).code).toBe(403);
    expect(handleSkillControl({ op: 'promote', skill_id: 'developer.custom' } as any, io).code).toBe(403);
    // a request carrying a guardrail/policy/real_api field → refused regardless of op
    expect(handleSkillControl({ op: 'toggle', skill_id: 'developer.custom', enabled: true, real_api_calls: true } as any, io).code).toBe(403);
    expect(handleSkillControl({ op: 'toggle', skill_id: 'developer.custom', enabled: true, allowed_write_set: ['**'] } as any, io).code).toBe(403);
    expect(handleSkillControl({ op: 'toggle', skill_id: 'developer.custom', enabled: true, policy: { default_deny: false } } as any, io).code).toBe(403);
  });

  it('boundary_server_enforced_in_code_not_ui_politeness — even a well-formed-looking forbidden request is rejected by the handler', () => {
    // The handler (server) decides; there is no UI in this test. A toggle that smuggles a
    // guardrail field is rejected by code, proving enforcement is server-side.
    const before = JSON.stringify(cat);
    const r = handleSkillControl({ op: 'toggle', skill_id: 'developer.custom', enabled: false, default_deny: false } as any, io);
    expect(r.code).toBe(403);
    expect(JSON.stringify(cat)).toBe(before); // nothing mutated
  });
});

/**
 * STORY-GATE.6 — adversarial proof of the §4d cockpit boundary (set ≠ effective).
 *
 * GATE.5 WROTE the boundary; this PROVES it is ENFORCED. Every boundary-crossing
 * attempt is a real adversarial request asserted REFUSED by the server (handleSkillControl
 * / decideSkillControl — the endpoints are thin wrappers over these), with the catalog
 * unmutated. The strongest guarantee is structural: the handler's only IO is the skill
 * catalog, so it CANNOT touch policy.yaml / real_api_calls / write-set / tool grants —
 * proven here by snapshotting the real policy.yaml across the whole adversarial barrage.
 *
 * Scripted/offline; real_api_calls untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleSkillControl, type SkillCatalog } from '../apps/api/src/skillControl';

const repoRoot = fileURLToPath(new URL('../', import.meta.url)); // gateloop/

function freshCatalog(): SkillCatalog {
  return { skills: [
    { skill_id: 'developer.ponytail-lazy', agent_role: 'developer', path: 'skills/developer/ponytail-lazy', status: 'registered', enabled: true, builtin: true },
    { skill_id: 'developer.custom', agent_role: 'developer', path: 'skills/developer/custom', status: 'registered', enabled: true, builtin: false },
  ] };
}

/** Run one request against a fresh in-memory catalog; report code + whether catalog changed. */
function attempt(req: any): { code: number; body: any; mutated: boolean; catalog: SkillCatalog } {
  let cat = freshCatalog();
  const before = JSON.stringify(cat);
  const io = { read: () => cat, write: (c: SkillCatalog) => { cat = c; } };
  const r = handleSkillControl(req, io);
  return { code: r.code, body: r.body, mutated: JSON.stringify(cat) !== before, catalog: cat };
}

/** assert a request was REFUSED (403) and the catalog was not mutated. */
function assertRefused(req: any) {
  const r = attempt(req);
  expect(r.code).toBe(403);
  expect(r.mutated).toBe(false);
  return r;
}

describe('STORY-GATE.6 §4d boundary — RED LINE 1: weaken a guardrail → refused', () => {
  it('adversarial_weaken_guardrail_request_refused (write-set / default-deny / isolation / tools)', () => {
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, allowed_write_set: ['**'] });
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, default_deny: false });
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, isolation: { network: true } });
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, allowed_tools: ['bash'] });
    // camelCase variants must also be refused (hardened regex)
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, allowedTools: ['bash'] });
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, writeSet: ['**'] });
    // a dedicated weaken op is not even a permitted operation
    assertRefused({ op: 'weaken_writeset', skill_id: 'developer.custom' });
    assertRefused({ op: 'disable_default_deny' });
  });
});

// STORY-TRUST.1 (ADR-0013): what was RED LINE 2 — "bypass the test-gate → refused" — is
// RETIRED. The test-gate no longer exists, so a cockpit add is PERMITTED unvalidated
// (operator-trust). The remaining red lines (overreach / real_api / promotion / builtin
// delete) are NOT the test-gate and stay refused (proven by the other describes).
describe('STORY-TRUST.1 §4d boundary — the test-gate is RETIRED (was RED LINE 2)', () => {
  it('add_without_tests_is_permitted_not_refused (test-gate retired)', () => {
    const r = attempt({ op: 'add', manifest: { skill_id: 'developer.untested', agent_role: 'developer', path: 'p', tests: [] } });
    expect(r.code).toBe(200);                       // permitted — no 403 test-gate refusal
  });

  it('self_register_add_is_no_longer_refused (operator-trust)', () => {
    const r = attempt({ op: 'add', manifest: { skill_id: 'developer.self', agent_role: 'developer', path: 'p', tests: ['t'], status: 'registered' } });
    expect(r.code).toBe(200);                       // the decision layer permits it
  });

  it('a direct "register" op still does not exist — refused (safe-ops guard, NOT the test-gate)', () => {
    assertRefused({ op: 'register', skill_id: 'evil' });
  });

  it('residual: apps/api still stamps a cockpit-added skill needs_tests (out of TRUST.1 write-set, not a gate)', () => {
    // apps/api/skillControl.ts is outside STORY-TRUST.1's write-set; it still labels a
    // cockpit add `needs_tests`. That is a staging LABEL, not a registration gate — the
    // operator can register directly via skill-runtime (canRegisterSkill permits).
    const r = attempt({ op: 'add', manifest: { skill_id: 'developer.new', agent_role: 'developer', path: 'p', tests: ['tests/test_skill.py'] } });
    expect(r.code).toBe(200);
    expect(r.catalog.skills.find(s => s.skill_id === 'developer.new')!.status).toBe('needs_tests');
  });
});

describe('STORY-GATE.6 §4d boundary — RED LINE 3: open real_api_calls → refused + stays false', () => {
  it('adversarial_enable_real_api_calls_from_frontend_refused', () => {
    assertRefused({ op: 'enable_real_api_calls' });
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, real_api_calls: true });
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, realApiCalls: true }); // camelCase too
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, kill_switch: false });
  });

  it('real_api_calls.enabled stays false — the gate is structurally untouchable from skill control', () => {
    const policyPath = path.join(repoRoot, 'configs', 'policy.yaml');
    const before = fs.readFileSync(policyPath, 'utf8');
    // fire the entire adversarial barrage; none of it can reach policy.yaml
    for (const req of [
      { op: 'enable_real_api_calls' },
      { op: 'toggle', skill_id: 'developer.custom', enabled: true, real_api_calls: true },
      { op: 'toggle', skill_id: 'developer.custom', enabled: true, policy: { real_api_calls: { enabled: true } } },
    ]) attempt(req);
    const after = fs.readFileSync(policyPath, 'utf8');
    expect(after).toBe(before);                     // policy.yaml byte-identical
    expect(/real_api_calls:\s*\n\s*enabled:\s*false/.test(after)).toBe(true); // still false / fail-closed
  });
});

describe('STORY-GATE.6 §4d boundary — RED LINE 4: overreach / self-promote → refused', () => {
  it('adversarial_trigger_overreach_or_self_promote_refused', () => {
    assertRefused({ op: 'promote', skill_id: 'developer.custom' });
    assertRefused({ op: 'self_promote' });
    assertRefused({ op: 'promote_to_stable', skill_id: 'developer.custom' });
    assertRefused({ op: 'exec', command: 'rm -rf /' });
    assertRefused({ op: 'run_agent', skill_id: 'developer.custom' });
    assertRefused({ op: 'toggle', skill_id: 'developer.custom', enabled: true, promotion: 'stable' });
  });
});

describe('STORY-GATE.6 §4d boundary — smuggling fully generalised + structural guarantee', () => {
  it('every legal op + smuggled guardrail field is refused; only-legal still works', () => {
    const smuggle = ['real_api_calls', 'policy', 'allowed_write_set', 'default_deny', 'isolation', 'allowed_tools', 'sudo', 'secret', 'promotion', 'container', 'network'];
    for (const field of smuggle) {
      for (const base of [
        { op: 'toggle', skill_id: 'developer.custom', enabled: false },
        { op: 'delete', skill_id: 'developer.custom' },
      ]) {
        const r = assertRefused({ ...base, [field]: true });
        expect(r.body.boundary).toBe('server-enforced'); // refusal comes from server code
      }
    }
    // the SAME ops WITHOUT smuggling succeed — proving it's the smuggled field that's refused, not the op
    expect(attempt({ op: 'toggle', skill_id: 'developer.custom', enabled: false }).code).toBe(200);
    expect(attempt({ op: 'delete', skill_id: 'developer.custom' }).code).toBe(200);
  });

  it('structural: across the whole barrage the ONLY thing mutated is the skill catalog', () => {
    // A spy IO that records writes. Whatever the request, the handler can only ever hand
    // back a SkillCatalog (skills array) — it has NO path to policy/real_api/write-set.
    const writes: SkillCatalog[] = [];
    let cat = freshCatalog();
    const io = { read: () => cat, write: (c: SkillCatalog) => { writes.push(c); cat = c; } };
    for (const req of [
      { op: 'toggle', skill_id: 'developer.custom', enabled: false, real_api_calls: true }, // refused
      { op: 'delete', skill_id: 'developer.ponytail-lazy' },                                 // refused (builtin)
      { op: 'toggle', skill_id: 'developer.custom', enabled: false },                        // allowed
    ]) handleSkillControl(req as any, io);
    // every persisted object is a pure skill catalog — keys are only {skills}
    for (const w of writes) expect(Object.keys(w)).toEqual(['skills']);
    // and each skill entry only carries catalog fields (no guardrail/policy/real_api keys ever)
    for (const w of writes) for (const s of w.skills) {
      for (const k of Object.keys(s)) expect(/real_api|policy|write_set|default_deny|allowed_tools|isolation|promotion/i.test(k)).toBe(false);
    }
  });

  it('set≠effective: the boundary is ENFORCED (server rejects), not merely documented', () => {
    // the proof is the assertions above firing on real requests — summarised here:
    // a refused request returns 403 AND leaves the catalog untouched; an allowed one mutates.
    expect(attempt({ op: 'enable_real_api_calls' }).code).toBe(403);
    expect(attempt({ op: 'toggle', skill_id: 'developer.custom', enabled: false }).mutated).toBe(true);
  });
});

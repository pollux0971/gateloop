/**
 * STORY-TRUST.6 — close the apps/ scoping gap + prove the honesty sweep is genuinely widened.
 *
 * TRUST.5's "0 phantom" excluded apps/, so the retired test-gate's API/UI surfaces survived.
 * This proves: the API registers added skills ACTIVE (not benched as needs_tests), the UI no
 * longer advertises a needs_tests "awaiting test-gate" badge, the skill-runtime/gate-control
 * engines are untouched (the gate died by removing the API stamp, not by changing the engine),
 * the tool-layer no-Bash is still real, and the sweep now covers apps/ + all source and FAILS
 * (non-zero) on any planted phantom — no echo placeholder, no || true.
 *
 * Scripted/offline; real_api_calls untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleSkillControl, type SkillCatalog } from '../apps/api/src/skillControl.ts';
import { selectSkillsForRole, type FullSkillManifest } from '@gateloop/skill-runtime';
import { providerToolSet, isShellLikeTool } from '@gateloop/tool-interface';
import { sweepPhantomClaims } from '../scripts/honesty-sweep.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url)); // gateloop/
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

function freshCatalog(): SkillCatalog {
  return { skills: [{ skill_id: 'developer.existing', agent_role: 'developer', path: 'skills/developer/existing', status: 'registered', enabled: true, builtin: false }] };
}

describe('STORY-TRUST.6 — API path: test-gate dead, skill registered active', () => {
  it('api_skillcontrol_no_longer_stamps_needs_tests_or_emits_test_gate_note', () => {
    let cat = freshCatalog();
    const io = { read: () => cat, write: (c: SkillCatalog) => { cat = c; } };
    const r = handleSkillControl({ op: 'add', manifest: { skill_id: 'developer.added', agent_role: 'developer', path: 'skills/developer/added', tests: [] } }, io);
    expect(r.code).toBe(200);
    const added = cat.skills.find(s => s.skill_id === 'developer.added')!;
    expect(added.status).toBe('registered');                 // NOT needs_tests
    expect(added.status).not.toBe('needs_tests');
    expect(JSON.stringify(r.body)).not.toMatch(/needs_tests|must pass the lifecycle test-gate/);
  });

  it('api_added_skill_is_active_for_its_role_not_benched', () => {
    let cat = freshCatalog();
    const io = { read: () => cat, write: (c: SkillCatalog) => { cat = c; } };
    handleSkillControl({ op: 'add', manifest: { skill_id: 'developer.added', agent_role: 'developer', path: 'skills/developer/added', tests: [] } }, io);
    // selectSkillsForRole returns only status==='registered' — the added skill is ACTIVE, not benched
    const active = selectSkillsForRole(cat.skills as unknown as FullSkillManifest[], 'developer').map(s => s.skill_id);
    expect(active).toContain('developer.added');
  });
});

describe('STORY-TRUST.6 — UI no longer advertises the retired gate', () => {
  it('web_ui_no_longer_renders_a_needs_tests_awaiting_test_gate_status', () => {
    const skillsPage = read('apps/web/src/SkillsPage.tsx');
    const app = read('apps/web/src/App.tsx');
    // the status union + colour map no longer model a needs_tests state, and App.tsx no longer branches on it
    expect(skillsPage).not.toMatch(/needs_tests:\s*'#/);             // no needs_tests colour entry
    expect(skillsPage).not.toMatch(/'needs_tests'/);                 // not in the status union literal
    expect(app).not.toMatch(/=== 'needs_tests'/);                    // no needs_tests rendering branch
  });
});

describe('STORY-TRUST.6 — engines untouched + tool-layer no-Bash still real', () => {
  it('skill_runtime_and_gate_control_engines_unchanged (mechanism intact: exclusion still works)', () => {
    // The lifecycle mechanism is NOT deleted — selectSkillsForRole still excludes non-registered
    // statuses (that is unchanged engine behaviour); the fix was to stop the API stamping
    // needs_tests, not to change this exclusion.
    const ms: FullSkillManifest[] = [
      { skill_id: 'developer.on', agent_role: 'developer', path: 'p', status: 'registered' },
      { skill_id: 'developer.benched', agent_role: 'developer', path: 'p', status: 'needs_tests' },
    ];
    const active = selectSkillsForRole(ms, 'developer').map(s => s.skill_id);
    expect(active).toEqual(['developer.on']);            // engine still excludes needs_tests (unchanged)
  });

  it('tool_layer_no_bash_by_construction_still_real_and_untouched', () => {
    expect(providerToolSet().some(t => isShellLikeTool(t.name))).toBe(false);
    expect(isShellLikeTool('bash')).toBe(true);          // detector intact
  });
});

describe('STORY-TRUST.6 — the honesty sweep is genuinely widened and fails on any phantom', () => {
  it('honesty_sweep_still_reports_zero_across_all_source (apps + docs + ADR + packages + scripts + tests)', () => {
    expect(sweepPhantomClaims(repoRoot)).toEqual([]);
  });

  it('honesty_sweep_scope_widened_to_apps + asserts_both_classes + exits_nonzero_on_any_phantom + no false positive', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trust6-sweep-'));
    try {
      // planted TEST-GATE phantom under apps/ (the scope TRUST.5 was blind to)
      fs.mkdirSync(path.join(tmp, 'apps/api/src'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'apps/api/src/evil.ts'), 'return { note: "must pass the lifecycle test-gate to register" };');
      // planted EXECUTION-WALL phantom under docs/ (TRUST.5's original class still asserted)
      fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'docs/wall.md'), 'The sandbox is the sole trust boundary and the egress cage is proven.');
      // an HONESTLY-disclaimed file must NOT be flagged (false-positive guard the operator asked for)
      fs.writeFileSync(path.join(tmp, 'docs/honest.md'), 'Historically skills required tests to register, but the test-gate is retired per ADR-0013 (operator-trust).');

      const v = sweepPhantomClaims(tmp);
      const files = v.map(x => x.file);
      const classes = new Set(v.map(x => x.cls));
      expect(files).toContain('apps/api/src/evil.ts');     // WIDENED to apps/ — the TRUST.5 blind spot
      expect(classes.has('test-gate')).toBe(true);          // test-gate class asserted
      expect(classes.has('execution-wall')).toBe(true);     // execution-wall class still asserted
      expect(files).not.toContain('docs/honest.md');        // disclaimed file is NOT a false positive
      expect(v.length).toBeGreaterThan(0);                  // non-zero on phantom (the runnable script exits non-zero)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('STORY-TRUST.6 — docs claim no test-gate/validation on skill add', () => {
  it('docs_state_no_test_gate_or_validation_on_skill_add_no_phantom_claim', () => {
    const lifecycle = read('docs/workflows/08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md');
    const apiSrc = read('apps/api/src/skillControl.ts');
    expect(lifecycle).toMatch(/ADR-0013/);
    expect(lifecycle.toLowerCase()).toMatch(/unvalidated|optional self-check/);
    expect(lifecycle).not.toMatch(/cannot be registered/i);
    // the API source itself no longer emits the retired-gate note
    expect(apiSrc).not.toMatch(/must pass the lifecycle test-gate to register/);
  });
});

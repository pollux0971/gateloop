import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSkillForRole, validateSkillPackage, rejectSkillWithoutTests, loadSkillManifest,
  selectSkillsForRole, sortByDependencyOrder, readSkillContent, loadMountedSkillsForRole,
  type FullSkillManifest,
} from './index';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chsk-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('skill-runtime', () => {
  it('is_skill_for_role_true', () => expect(isSkillForRole({ skill_id: 's', agent_role: 'developer', path: 'p' }, 'developer')).toBe(true));
  it('validate_skill_package_requires_tests', () => expect(validateSkillPackage({ skill_id: 's', agent_role: 'developer', tests: [] }).ok).toBe(false));
  it('valid_skill_package_passes', () => expect(validateSkillPackage({ skill_id: 's', agent_role: 'developer', tests: ['t.test.ts'] }).ok).toBe(true));
  it('reject_skill_without_tests_true', () => expect(rejectSkillWithoutTests({ skill_id: 's', agent_role: 'developer' })).toBe(true));
  it('reject_skill_with_tests_false', () => expect(rejectSkillWithoutTests({ skill_id: 's', agent_role: 'developer', tests: ['t'] })).toBe(false));
  it('load_skill_manifest_parses_json', () => {
    fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ skill_id: 'x', agent_role: 'debugger' }));
    expect(loadSkillManifest(dir).skill_id).toBe('x');
  });
});

function makeManifest(
  id: string,
  role: FullSkillManifest['agent_role'],
  status: string,
  deps: string[] = [],
): FullSkillManifest {
  // Strip role prefix (e.g. "developer.test-skill" → "test-skill") for the dir path
  const dirName = id.includes('.') ? id.split('.').slice(1).join('.') : id;
  return {
    skill_id: id,
    agent_role: role,
    status: status as FullSkillManifest['status'],
    path: `skills/${role}/${dirName}`,
    tests: ['tests/test_skill.py'],
    depends_on: deps,
  };
}

describe('skill-selection', () => {
  it('skills_selected_by_role_and_phase', () => {
    const m = [makeManifest('a', 'developer', 'registered'), makeManifest('b', 'supervisor', 'registered')];
    expect(selectSkillsForRole(m, 'developer').map(s => s.skill_id)).toEqual(['a']);
  });

  it('quarantined_skills_never_loaded', () => {
    const m = [makeManifest('a', 'developer', 'registered'), makeManifest('b', 'developer', 'quarantined')];
    expect(selectSkillsForRole(m, 'developer').map(s => s.skill_id)).toEqual(['a']);
  });

  it('dependency_ordered_loading', () => {
    const A = makeManifest('skill-a', 'developer', 'registered', []);
    const B = makeManifest('skill-b', 'developer', 'registered', ['skill-a']);
    const sorted = sortByDependencyOrder([B, A]);
    expect(sorted.map(s => s.skill_id)).toEqual(['skill-a', 'skill-b']);
  });

  it('cycle_detection_throws', () => {
    const A = makeManifest('skill-a', 'developer', 'registered', ['skill-b']);
    const B = makeManifest('skill-b', 'developer', 'registered', ['skill-a']);
    expect(() => sortByDependencyOrder([A, B])).toThrow(/cycle/i);
  });

  it('skill_memory_avoid_lines_included', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skrt-'));
    try {
      const skillDir = path.join(root, 'skills', 'developer', 'test-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\n\nDo the thing.');
      fs.writeFileSync(path.join(skillDir, '.memory.md'), 'Some notes\nAVOID: never do X\nAVOID: always do Y\n');
      fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
        skill_id: 'developer.test-skill', agent_role: 'developer',
        path: 'skills/developer/test-skill', tests: ['tests/t.py'],
      }));
      const skill = makeManifest('developer.test-skill', 'developer', 'registered');
      const content = readSkillContent(skill, root);
      expect(content.avoid_lines.length).toBe(2);
      expect(content.skill_md).toContain('Do the thing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── STORY-UST.1: loadMountedSkillsForRole (body-carrying, dependency-ordered) ──
function scaffoldSkill(repoRoot: string, relPath: string, skillJson: object, skillMd: string, avoid?: string) {
  const d = path.join(repoRoot, relPath);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'skill.json'), JSON.stringify(skillJson, null, 2));
  fs.writeFileSync(path.join(d, 'SKILL.md'), skillMd);
  if (avoid) fs.writeFileSync(path.join(d, '.memory.md'), `AVOID: ${avoid}\nnote: ignored\n`);
}

describe('STORY-UST.1 loadMountedSkillsForRole', () => {
  it('returns registered role skills with body+avoid, dependency-ordered, frontmatter stripped', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chust-'));
    try {
      // dep skill "base" → dependent skill "lazy"; "draft" excluded; other role excluded
      scaffoldSkill(root, 'skills/developer/base',
        { skill_id: 'developer.base', agent_role: 'developer', description: 'base rules\nsecond line', tests: ['t'], depends_on: [] },
        '---\nname: base\n---\n# Base\nBASE-BODY');
      scaffoldSkill(root, 'skills/developer/lazy',
        { skill_id: 'developer.lazy', agent_role: 'developer', description: 'lazy ladder', tests: ['t'], depends_on: ['developer.base'] },
        '# Lazy\nLAZY-BODY', 'over-build nothing');
      scaffoldSkill(root, 'skills/developer/draft',
        { skill_id: 'developer.draft', agent_role: 'developer', description: 'wip', tests: ['t'], depends_on: [] },
        '# Draft\nDRAFT-BODY');
      scaffoldSkill(root, 'skills/reviewer/rev',
        { skill_id: 'reviewer.rev', agent_role: 'reviewer', description: 'rev', tests: ['t'], depends_on: [] },
        '# Rev\nREV-BODY');
      fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(root, 'skills', 'skill_manifest.json'), JSON.stringify({
        skills: [
          { skill_id: 'developer.lazy', agent_role: 'developer', path: 'skills/developer/lazy', status: 'registered' },
          { skill_id: 'developer.base', agent_role: 'developer', path: 'skills/developer/base', status: 'registered' },
          { skill_id: 'developer.draft', agent_role: 'developer', path: 'skills/developer/draft', status: 'needs_tests' },
          { skill_id: 'reviewer.rev', agent_role: 'reviewer', path: 'skills/reviewer/rev', status: 'registered' },
        ],
      }, null, 2));

      const mounted = loadMountedSkillsForRole('developer', root);
      // only registered developer skills (draft + other role excluded)
      expect(mounted.map(m => m.name)).toEqual(['developer.base', 'developer.lazy']); // dep before dependent
      // body carried, frontmatter stripped
      expect(mounted[0].body).toContain('BASE-BODY');
      expect(mounted[0].body).not.toContain('---'); // frontmatter gone
      expect(mounted[0].body).not.toContain('name: base');
      // avoid carried
      expect(mounted[1].avoid).toContain('AVOID: over-build nothing');
      // summary from description first line
      expect(mounted[0].summary).toBe('base rules');
      expect(mounted[0].token_estimate).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fail-soft: missing catalog → []', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chust2-'));
    try {
      expect(loadMountedSkillsForRole('developer', root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── STORY-UST.2: ponytail-lazy is registered and mounts WITH its body (real repo) ──
import { fileURLToPath } from 'node:url';
describe('STORY-UST.2 ponytail-lazy registered developer skill', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)); // packages/skill-runtime/src → gateloop/
  it('loads as a registered developer skill with the lazy-ladder body + coordination edits', () => {
    const mounted = loadMountedSkillsForRole('developer', repoRoot);
    const pony = mounted.find(m => m.name === 'developer.ponytail-lazy');
    expect(pony).toBeDefined();
    // the actual SKILL.md body reached the mount (not just a name bullet) — the UST.1 wire
    expect(pony!.body.toLowerCase()).toContain('lazy senior developer');
    expect(pony!.body).toContain('minimum code that works');
    // ADR-023 §3.3 coordination edit 1: deletion bounded by the additive gate
    expect(pony!.body).toContain('Never remove an existing exported');
    expect(pony!.body.toLowerCase()).toContain('additive gate');
    // coordination edit 2: question via escalation, not silent under-building
    expect(pony!.body.toLowerCase()).toContain('escalation');
    // host cruft stripped (GateLoop injects via composeSystemPrompt, not host hooks/MCP)
    expect(pony!.body.toLowerCase()).not.toContain('claude code');
    expect(pony!.body.toLowerCase()).not.toContain('statusline');
  });
});

// ── STORY-GATE.4: enabled + builtin flags + mutation policy ──
import { skillEnabled, setSkillEnabled, canDeleteSkill, canRegisterSkill, decideSkillControl } from './index';
describe('STORY-GATE.4 enabled + builtin', () => {
  const dev = (o: Partial<FullSkillManifest>): FullSkillManifest =>
    ({ skill_id: 'developer.x', agent_role: 'developer', path: 'skills/developer/x', status: 'registered', tests: ['t'], ...o });

  it('enabled_flag_per_skill_default_true', () => {
    expect(skillEnabled({})).toBe(true);            // undefined → true
    expect(skillEnabled({ enabled: true })).toBe(true);
    expect(skillEnabled({ enabled: false })).toBe(false);
  });

  it('runtime_filter_selectSkillsForRole_respects_enabled', () => {
    const ms = [dev({ skill_id: 'developer.on' }), dev({ skill_id: 'developer.off', enabled: false })];
    expect(selectSkillsForRole(ms, 'developer').map(s => s.skill_id)).toEqual(['developer.on']);
  });

  it('toggle_enabled_un_gated_instant_user_decision', () => {
    // setSkillEnabled is a pure mutation — no gate, no test, no approval
    const off = setSkillEnabled(dev({ skill_id: 'developer.x' }), false);
    expect(off.enabled).toBe(false);
    expect(setSkillEnabled(off, true).enabled).toBe(true);
  });

  it('builtin_flag_ponytail_lazy_and_review_marked_builtin (catalog)', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const cat = JSON.parse(fs.readFileSync(path.join(repoRoot, 'skills', 'skill_manifest.json'), 'utf8'));
    const pony = cat.skills.filter((s: any) => s.skill_id === 'developer.ponytail-lazy' || s.skill_id === 'reviewer.ponytail-review');
    expect(pony.length).toBe(2);
    for (const s of pony) expect(s.builtin).toBe(true);
  });

  it('delete_builtin_refused_disable_instead', () => {
    expect(canDeleteSkill({ builtin: true, skill_id: 'developer.ponytail-lazy' }).ok).toBe(false);
    expect(canDeleteSkill({ builtin: true, skill_id: 'developer.ponytail-lazy' }).error).toMatch(/disable it instead/);
    expect(canDeleteSkill({ builtin: false, skill_id: 'user.custom' }).ok).toBe(true);   // non-builtin deletes freely
    expect(canDeleteSkill({ skill_id: 'user.custom' }).ok).toBe(true);                    // undefined builtin = deletable
  });

  it('add_new_skill_registers_unvalidated_operator_trust (STORY-TRUST.1: test-gate retired)', () => {
    // ADR-0013 §2: a skill the operator adds is registered AS-IS — tests are NOT required.
    expect(canRegisterSkill(dev({ skill_id: 'user.new', tests: [] })).ok).toBe(true);
    expect(canRegisterSkill(dev({ skill_id: 'user.new' })).ok).toBe(true);   // tests field absent → still ok
    expect(canRegisterSkill(dev({ skill_id: 'user.new', tests: ['tests/test_skill.py'] })).ok).toBe(true);
  });

  it('disabling a builtin is allowed (can-disable-cannot-delete)', () => {
    const pony = dev({ skill_id: 'developer.ponytail-lazy', builtin: true });
    expect(setSkillEnabled(pony, false).enabled).toBe(false); // disable: fine
    expect(canDeleteSkill(pony).ok).toBe(false);              // delete: refused
  });
});

// ── STORY-TRUST.1: retire the test-gate (ADR-0013 §2 operator-trust) ──
// The six behaviors_must_pass. Disciplined removal: the gate stops gating, the
// self-check machinery STAYS, and the docs say exactly what now happens (no phantom
// validation claim). The overreach guard (policy/real_api/promotion) is NOT the
// test-gate and is asserted to STAY — this epic removes execution-side walls, not the
// human-only real_api gate or the cockpit→policy boundary.
describe('STORY-TRUST.1 retire the test-gate', () => {
  const tdev = (o: Partial<FullSkillManifest>): FullSkillManifest =>
    ({ skill_id: 'user.custom', agent_role: 'developer', path: 'skills/developer/custom', status: 'registered', ...o });
  const noFind = { findSkill: () => undefined };

  it('skill_registration_no_longer_requires_tests', () => {
    expect(canRegisterSkill(tdev({ tests: [] })).ok).toBe(true);
    expect(canRegisterSkill(tdev({})).ok).toBe(true);            // tests field entirely absent
  });

  it('user_skill_installs_and_runs_unvalidated', () => {
    // an operator-registered skill with NO tests is registerable AND loads/runs (status registered)
    const untested = tdev({ skill_id: 'user.untested' }); // no tests
    expect(canRegisterSkill(untested).ok).toBe(true);
    expect(selectSkillsForRole([untested], 'developer').map(s => s.skill_id)).toEqual(['user.untested']);
  });

  it('tests_are_optional_self_check_never_a_gate', () => {
    const untested = tdev({ tests: [] });
    // the self-check still REPORTS missing tests (advisory)...
    expect(rejectSkillWithoutTests(untested)).toBe(true);
    expect(validateSkillPackage(untested).ok).toBe(false);
    // ...but it does NOT gate registration:
    expect(canRegisterSkill(untested).ok).toBe(true);
  });

  it('no_quarantine_no_leakage_audit_blocking_registration', () => {
    // registration is an unconditional permit — no quarantine/leakage/test-gate reason can appear
    expect(canRegisterSkill(tdev({ tests: [] })).ok).toBe(true);
    const d = decideSkillControl({ op: 'add', manifest: tdev({ tests: [] }) }, noFind);
    expect(d.allow).toBe(true);                                  // permitted, not blocked
    expect(d.reason).toMatch(/unvalidated|operator-trust/i);     // because the gate is retired
    // canRegisterSkill carries no quarantine/leakage failure path at all
    expect(canRegisterSkill(tdev({ tests: [] })).error).toBeUndefined();
  });

  it('test_runner_machinery_stays_as_optional_self_check_tool', () => {
    // the functions still EXIST and still report test-presence — kept, just not gating
    expect(typeof validateSkillPackage).toBe('function');
    expect(typeof rejectSkillWithoutTests).toBe('function');
    expect(rejectSkillWithoutTests(tdev({ tests: ['tests/t.py'] }))).toBe(false); // shipped tests → ok
    expect(validateSkillPackage(tdev({ tests: ['tests/t.py'] })).ok).toBe(true);
  });

  it('cockpit add is no longer test-gated, but the overreach guard STAYS (not the test-gate)', () => {
    expect(decideSkillControl({ op: 'add', manifest: tdev({ tests: [] }) }, noFind).allow).toBe(true);
    // self-register is no longer refused (operator-trust)
    expect(decideSkillControl({ op: 'add', manifest: tdev({ status: 'registered', tests: [] }) }, noFind).allow).toBe(true);
    // smuggling a guardrail/real_api field is STILL refused — this is NOT the test-gate
    expect(decideSkillControl({ op: 'add', manifest: tdev({ tests: [] }), real_api_calls: true }, noFind).allow).toBe(false);
    expect(decideSkillControl({ op: 'enable_real_api_calls' }, noFind).allow).toBe(false);
  });

  it('docs_state_registration_is_unvalidated_no_phantom_validation_claim', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const lifecycle = fs.readFileSync(path.join(repoRoot, 'docs/workflows/08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md'), 'utf8');
    const model = fs.readFileSync(path.join(repoRoot, 'docs/architecture/05_SKILL_RUNTIME_MODEL.md'), 'utf8');
    for (const doc of [lifecycle, model]) {
      expect(doc).toMatch(/ADR-0013/);                                  // points at the new reality
      expect(doc.toLowerCase()).toMatch(/unvalidated|optional self-check/);
      // no phantom validation claim: must not assert tests still gate/block registration
      expect(doc).not.toMatch(/cannot be registered/i);
      expect(doc).not.toMatch(/must pass the lifecycle test-gate before registration/i);
    }
  });
});

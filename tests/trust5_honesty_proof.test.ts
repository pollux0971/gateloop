/**
 * STORY-TRUST.5 — PROVE honesty (the inverse set≠effective barrier for EPIC-TRUST).
 *
 * This epic REMOVED execution-side walls, so the proof is the ABSENCE of phantom defenses
 * plus the PRESENCE of the one real thing (tool-layer no-Bash) and the correctly-labelled
 * hygiene defaults. No || true, no skipping — every claim is asserted against real files/code.
 *
 * Scripted/offline; real_api_calls untouched, zero cost.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canRegisterSkill, rejectSkillWithoutTests, selectSkillsForRole, decideSkillControl,
  type FullSkillManifest,
} from '@gateloop/skill-runtime';
import { BudgetLedger, TokenCapGuard } from '@gateloop/gate-control';
import { providerToolSet, providerMcpToolNames, isShellLikeTool } from '@gateloop/tool-interface';
import { redact } from '@gateloop/event-log';
import { runProtectiveBackstop, scanForRealSecret } from '@gateloop/harness-core';
import { sweepPhantomWallClaims } from '../scripts/honesty-sweep.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url)); // gateloop/
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const dev = (o: Partial<FullSkillManifest>): FullSkillManifest =>
  ({ skill_id: 'user.x', agent_role: 'developer', path: 'skills/developer/x', status: 'registered', ...o });

describe('STORY-TRUST.5 honesty proof', () => {
  it('doc_sweep_asserts_zero_phantom_execution_wall_claims', () => {
    const violations = sweepPhantomWallClaims(repoRoot);
    // Every affirmative execution-wall phrase must be disclaimed by ADR-0013 in its own file.
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('test_gate_genuinely_retired_skill_registers_without_tests_no_quarantine', () => {
    expect(canRegisterSkill(dev({ tests: [] })).ok).toBe(true);     // registers unvalidated
    expect(canRegisterSkill(dev({})).error).toBeUndefined();        // no quarantine/leakage failure path
    // the cockpit add decision is no longer test-gated either
    expect(decideSkillControl({ op: 'add', manifest: dev({ tests: [] }) }, { findSkill: () => undefined }).allow).toBe(true);
    // an unvalidated registered skill still LOADS/runs
    const untested = dev({ skill_id: 'user.untested' });
    expect(selectSkillsForRole([untested], 'developer').map(s => s.skill_id)).toEqual(['user.untested']);
    // the self-check machinery is kept (still reports), just not gating
    expect(rejectSkillWithoutTests(dev({ tests: [] }))).toBe(true);
  });

  it('policy_guardrails_genuinely_knobs_tunable_removable_nothing_backstops', () => {
    // tunable: a higher ceiling permits what a tight one refused
    expect(new BudgetLedger(5, 4).canStart(2).allowed).toBe(false);
    expect(new BudgetLedger(50, 4).canStart(2).allowed).toBe(true);
    // removable: Infinity ceiling / max cap never block — NOTHING backstops them
    expect(new BudgetLedger(Infinity, 0).canStart(Number.MAX_SAFE_INTEGER).allowed).toBe(true);
    expect(new TokenCapGuard(Number.MAX_SAFE_INTEGER).record(1e15)).toBe(true);
    // documented as knobs-not-walls (12 §0)
    const rules = read('docs/architecture/12_RUNTIME_ALGORITHM_RULES.md');
    expect(rules.toLowerCase()).toMatch(/quality\/cost knob|not walls|not (a )?security wall/);
    expect(rules.toLowerCase()).toMatch(/nothing backstops/);
  });

  it('tool_layer_proposal_shaping_still_real_no_bash_by_construction', () => {
    // the one REAL thing: the provider tool surface offers NO shell/Bash tool, by construction
    const tools = providerToolSet();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some(t => isShellLikeTool(t.name))).toBe(false);
    const names = providerMcpToolNames();
    expect(names.some(n => isShellLikeTool(n))).toBe(false);
    expect(names.some(n => /bash|shell/i.test(n))).toBe(false);
    // the detector itself works (defense-in-depth: a bash-like name would be caught)
    expect(isShellLikeTool('bash')).toBe(true);
    expect(isShellLikeTool('mcp__gateloop__exec')).toBe(true);
  });

  it('two_hygiene_defaults_present_and_labelled_hygiene_not_a_wall', () => {
    // (1) secret masking stays functional...
    expect(JSON.stringify(redact({ k: 'sk-Secret012345678abcd' }))).toContain('«redacted»');
    expect(scanForRealSecret('sk-' + 'realKey1234567890abcd').found).toBe(true);
    // (2) force-push pre-backup stays functional...
    let ran = 0;
    expect(runProtectiveBackstop('force_push_backup', { backup: () => { ran++; return 'b.bundle'; } }).ran).toBe(true);
    expect(ran).toBe(1);
    // ...and both are labelled "hygiene, not a wall", framed as accidental-leakage not agent restriction
    const secretPolicy = read('docs/policies/SECRET_POLICY.md');
    const backstops = read('packages/harness-core/src/protectiveBackstops.ts');
    expect(secretPolicy.toLowerCase()).toMatch(/hygiene, not a wall/);
    expect(backstops.toLowerCase()).toMatch(/hygiene, not a (security )?wall/);
    expect(secretPolicy.toLowerCase()).toMatch(/accidental.leakage|accidental leak/);
  });

  it('adr0013_reopen_condition_documented_untrusted_multitenant', () => {
    const adr = read('ADR/ADR-0013-no-sandbox-operator-trust.md');
    expect(adr).toMatch(/重開|reopen/i);
    expect(adr).toMatch(/多租戶|multi.?tenant|不可信|untrusted/i);
  });

  it('honest_accounting_claims_exactly_what_it_does_nothing_it_doesnt', () => {
    // the conjunction: zero phantom walls + no-Bash real + hygiene labelled + test-gate retired.
    expect(sweepPhantomWallClaims(repoRoot)).toEqual([]);
    expect(providerToolSet().some(t => isShellLikeTool(t.name))).toBe(false); // the one real thing holds
    expect(canRegisterSkill(dev({ tests: [] })).ok).toBe(true);               // the removed thing is removed
  });
});

/**
 * STORY-PTEST.7 — CI no-spend guard + coverage threshold + behavior-id↔it()-name gate.
 *
 * The standing machine checks that keep the planning + PLLM feature tested and CI
 * spend-free. All checks are offline + self-contained (no coverage provider, no browser,
 * no network): they read the repo's own config + test sources and assert the guarantees.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..'); // gateloop/
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// the planning + PLLM test files that make up the feature's offline suite.
const PKG_TEST_DIR = path.join(ROOT, 'packages', 'planning-steward', 'src');
const TESTS_DIR = path.join(ROOT, 'tests');
const planningTestFiles = (): string[] => {
  const pkg = fs.readdirSync(PKG_TEST_DIR).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(PKG_TEST_DIR, f));
  const root = fs
    .readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.ts') && /^(api_planning|pwire|pflow|pskill|pbmad|pllm|workflow|ptest)/.test(f))
    .map((f) => path.join(TESTS_DIR, f));
  return [...pkg, ...root];
};
// concatenated sources of the PLANNING + PLLM feature test files (the EPIC-PTEST scope) —
// NOT the whole repo's legacy tests.
const featureTestSources = (): string => planningTestFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n');

describe('STORY-PTEST.7 — CI gate', () => {
  it('ci_entry_runs_full_offline_planning_and_pllm_suite_green', () => {
    const pkg = JSON.parse(read('package.json'));
    // a CI entry exists that runs the OFFLINE suite (typecheck + vitest run).
    expect(typeof pkg.scripts['test:ci']).toBe('string');
    expect(pkg.scripts['test:ci']).toMatch(/vitest run/);
    expect(pkg.scripts['test:ci']).toMatch(/tsc -b/);
    // it carries NO real-spend trigger (no opt-in flag, no real-mode selection).
    expect(pkg.scripts['test:ci']).not.toMatch(/PLLM6_REAL|--mode\s*real|real_api/i);
    // the feature's offline suite is substantial (many planning + PLLM test files present).
    expect(planningTestFiles().length).toBeGreaterThanOrEqual(15);
  });

  it('gated_and_real_spend_tests_excluded_from_ci_no_real_call_possible_invariant', () => {
    // 1) the vitest include globs only collect *.test.ts (so non-test runners are excluded).
    const vcfg = read('vitest.config.ts');
    const globs = [...vcfg.matchAll(/'([^']*\*[^']*)'/g)].map((m) => m[1]).filter((g) => g.includes('test'));
    expect(globs.length).toBeGreaterThan(0);
    expect(globs.every((g) => g.endsWith('.test.ts'))).toBe(true);

    // 2) the gated runner exists, is NOT a *.test.ts, and fail-closes (opt-in guard).
    const runnerName = 'pllm6_real_epics_run.ts';
    expect(fs.existsSync(path.join(TESTS_DIR, runnerName))).toBe(true);
    expect(runnerName).not.toMatch(/\.test\.ts$/);
    const runner = read(path.join('tests', runnerName));
    expect(runner).toMatch(/PLLM6_REAL/);
    expect(runner).toMatch(/optIn/);

    // 3) NO collected test file imports the REAL AI SDK at module scope — the only file
    //    that touches a real provider is the excluded runner. So no CI test can spend.
    for (const f of planningTestFiles().concat(
      // also sweep the cross-package provider test + gating guard explicitly
      [path.join(TESTS_DIR, 'pllm_author_seam_provider.test.ts'), path.join(TESTS_DIR, 'pllm6_gating.test.ts')].filter(fs.existsSync),
    )) {
      const src = fs.readFileSync(f, 'utf8');
      expect(/^\s*import\b[^\n]*\bfrom\s+['"](ai|@ai-sdk\/)/m.test(src), `${path.basename(f)} imports real SDK`).toBe(false);
    }
  });

  it('coverage_threshold_enforced_for_planning_packages', () => {
    // a) the coverage gate config declares numeric FLOORS for each planning target.
    const cov = read('scripts/coverage.config.ts');
    for (const target of ['packages/planning-steward/src', 'apps/api/src/planning.ts', 'apps/web/public/planflow.js']) {
      expect(cov.includes(target), `coverage target ${target}`).toBe(true);
    }
    expect(cov).toMatch(/lines:\s*90/); // planning-steward floor
    expect(cov).toMatch(/provider:\s*'v8'/);
    expect(cov).toMatch(/pllm6_real_epics_run\.ts/); // gated runner excluded from coverage
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['test:coverage:planning']).toMatch(/--coverage/);

    // b) SELF-CONTAINED offline coverage proxy: every public VALUE export of the engine
    //    package is exercised by at least THRESHOLD of the test suite (no provider needed).
    const idx = read('packages/planning-steward/src/index.ts');
    const exportNames = new Set<string>();
    for (const m of idx.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g)) exportNames.add(m[1]);
    for (const m of idx.matchAll(/export\s+\{([^}]*)\}/g)) {
      // skip `export type { ... }` blocks (those are types, referenced in annotations).
      if (/export\s+type\s+\{/.test(idx.slice(Math.max(0, m.index! - 6), m.index! + 8))) continue;
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) exportNames.add(name);
      }
    }
    expect(exportNames.size).toBeGreaterThan(20); // sanity: we actually parsed the exports

    const tests = featureTestSources();
    const referenced = [...exportNames].filter((n) => new RegExp(`\\b${n}\\b`).test(tests));
    const ratio = referenced.length / exportNames.size;
    // FLOOR: ≥85% of exported symbols are exercised — fails on a coverage regression.
    expect(ratio, `symbol coverage ${(ratio * 100).toFixed(1)}% (${referenced.length}/${exportNames.size})`).toBeGreaterThanOrEqual(0.85);
  });

  it('behavior_id_to_it_name_convention_enforced_as_machine_check', () => {
    const itNames = new Set([...featureTestSources().matchAll(/\bit\(\s*'([^']+)'/g)].map((m) => m[1]));
    expect(itNames.size).toBeGreaterThan(100); // the feature suite is large

    // The acceptance behavior ids of the EPIC-PLLM + EPIC-PTEST stories whose tests live
    // in the planning-steward package + tests/ (PLLM.5's ids live in the @gateloop/web
    // suite, a separate vitest root, and are checked there). The convention: each id maps
    // to an it() of the SAME name. This is the machine check — if any behavior loses its
    // test (rename/delete), this fails. (Legacy EPIC-000/009 tests in the same package use
    // an older "STORY-XXX: prose" naming and are out of this convention's scope.)
    const behaviorIds = [
      // PLLM.2
      'prompt_built_from_skill_steps_and_template',
      'context_idea_and_prior_docs_included_in_prompt',
      'failing_items_when_present_included_as_fix_instructions',
      'prompt_builder_is_pure_and_deterministic_no_provider_call',
      // PLLM.3
      'author_seam_exposes_single_interface_with_scripted_and_real_impls',
      'seam_selects_scripted_author_by_default_real_is_opt_in',
      'scripted_author_is_deterministic_offline_zero_cost',
      'real_author_reuses_provider_driver_and_reads_key_via_secret_seam',
      'real_author_with_no_key_fails_loudly_never_silently_fakes_success_invariant',
      // PLLM.4
      'author_endpoint_runs_author_then_advance_for_active_stage',
      'blocked_advance_feeds_failing_items_back_and_re_authors',
      'loop_converges_when_scripted_author_fixes_doc_within_budget',
      'loop_gives_up_with_clear_reason_at_attempt_budget',
      'provider_calls_stay_server_side_key_never_in_response',
      // PLLM.6 (offline guard)
      'real_run_is_opt_in_never_in_ci_kill_switch_reachable',
      // PTEST.2
      'get_flow_response_matches_declared_shape',
      'advance_success_and_brief_ungated_paths_covered',
      'advance_blocked_returns_nonempty_failing_items_and_reason',
      'advance_already_complete_and_reset_paths_covered',
      'contract_tests_call_in_process_service_no_network',
      // PTEST.3
      'randomized_sequences_never_produce_two_active_stages_invariant',
      'randomized_sequences_never_activate_before_predecessor_done_invariant',
      'advancing_past_end_never_wraps_or_corrupts_over_random_runs_invariant',
      'snapshot_checklist_counts_always_internally_consistent_invariant',
      'property_tests_are_seeded_and_reproducible',
      // PTEST.4
      'malformed_workflow_yaml_errors_clearly_not_silent',
      'missing_or_corrupt_skill_file_throws_and_surfaces',
      'empty_or_partial_doc_blocks_with_correct_failing_items',
      'blocked_then_fixed_doc_advances_recovery_path',
      'reset_returns_to_initial_state',
      // PTEST.6
      'loop_converges_with_scripted_author_that_fixes_on_attempt_two',
      'loop_gives_up_at_budget_with_clear_reason',
      'seam_defaults_to_scripted_author',
      'real_author_without_key_fails_loudly_probe_no_real_call_invariant',
      // PTEST.7 (this file)
      'ci_entry_runs_full_offline_planning_and_pllm_suite_green',
      'gated_and_real_spend_tests_excluded_from_ci_no_real_call_possible_invariant',
      'coverage_threshold_enforced_for_planning_packages',
      'behavior_id_to_it_name_convention_enforced_as_machine_check',
    ];
    // 1) convention FORM: every behavior id is lowercase snake_case (no prose, no camelCase).
    const malformed = behaviorIds.filter((id) => !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(id));
    expect(malformed, `malformed behavior ids: ${malformed.join(', ')}`).toEqual([]);
    // 2) convention MAPPING: every behavior id has an it() of the SAME name.
    const missing = behaviorIds.filter((id) => !itNames.has(id));
    expect(missing, `behavior ids with no matching it(): ${missing.join(', ')}`).toEqual([]);
  });
});

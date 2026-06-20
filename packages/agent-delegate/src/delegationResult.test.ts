import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDelegationResult,
  validateDelegationResult,
  diffFileSet,
  detectClaimMismatch,
  acquireSelfReport,
  cliUsesNativeSchema,
  type DelegationResult,
} from './delegationResult';
import type { AgentEvent } from './seam-types';

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../specs/delegation_result.schema.json',
);

const DIFF_A = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1 +1 @@',
  '-export const a = 1;',
  '+export const a = 2;',
].join('\n');

const DIFF_TWO = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git a/sub/b.ts b/sub/b.ts',
  '--- a/sub/b.ts',
  '+++ b/sub/b.ts',
  '@@ -1 +1 @@',
  '-p',
  '+q',
].join('\n');

const completion = (input: number, output: number): AgentEvent => ({
  cli: 'claude', kind: 'completion', summary: 'done', stop_reason: 'end_turn', tokens: { input, output },
});

describe('agent-delegate / delegation result contract (STORY-033.5)', () => {
  // ── result_schema_defined_diff_authoritative ──
  it('result_schema_defined_diff_authoritative', () => {
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    expect(schema.required).toContain('diff');
    expect(schema.properties.diff.description).toMatch(/AUTHORITATIVE/);
    expect(schema.properties.claimed_changes.description).toMatch(/ADVISORY/);
    expect(schema.properties.agent_self_report.description).toMatch(/ADVISORY/);

    // the built result carries the diff verbatim as the authoritative field
    const r = buildDelegationResult({ cli: 'claude', diff: DIFF_A, events: [completion(10, 5)] });
    expect(r.diff).toBe(DIFF_A);
    expect(validateDelegationResult(r).ok).toBe(true);
  });

  it('diffFileSet parses the authoritative changed-file set', () => {
    expect(diffFileSet(DIFF_A)).toEqual(['a.ts']);
    expect(diffFileSet(DIFF_TWO)).toEqual(['a.ts', 'sub/b.ts']);
    expect(diffFileSet('')).toEqual([]);
  });

  // ── per_cli_adapters_map_to_one_shape ──
  it('per_cli_adapters_map_to_one_shape: claude/codex/gemini → identical shape', () => {
    for (const cli of ['claude', 'codex', 'gemini'] as const) {
      const r = buildDelegationResult({
        cli,
        diff: DIFF_A,
        events: [completion(20, 8)],
        self_report_raw: { claimed_changes: ['a.ts'] },
      });
      expect(validateDelegationResult(r).ok).toBe(true);
      expect(r.cli).toBe(cli);
      expect(r.driver).toBe('headless');
      expect(r.diff).toBe(DIFF_A);
      expect(r.tokens).toEqual({ input: 20, output: 8 });
      expect(r.stop_reason).toBe('end_turn');
      // one fixed set of keys regardless of CLI
      expect(Object.keys(r).sort()).toEqual(
        ['agent_self_report', 'claimed_changes', 'cli', 'diff', 'driver', 'kill_reason', 'killed', 'self_report_source', 'stop_reason', 'tokens', 'warnings'].sort(),
      );
    }
  });

  // ── native_schema_used_else_validate_on_receipt ──
  it('native_schema_used_else_validate_on_receipt', () => {
    expect(cliUsesNativeSchema('claude')).toBe(true);
    expect(cliUsesNativeSchema('codex')).toBe(true);
    expect(cliUsesNativeSchema('gemini')).toBe(false);

    const claude = acquireSelfReport('claude', { claimed_changes: ['a.ts'], note: 'ok' });
    expect(claude.source).toBe('native_schema');

    const codex = acquireSelfReport('codex', { claimed_changes: ['a.ts'] });
    expect(codex.source).toBe('native_schema');

    // Gemini: well-formed → validated-on-receipt
    const gemini = acquireSelfReport('gemini', { claimed_changes: ['a.ts'] });
    expect(gemini.source).toBe('validated_on_receipt');

    // non-conforming self-report → dropped, flagged, never trusted (any CLI)
    const bad = acquireSelfReport('gemini', { claimed_changes: 'not-an-array' });
    expect(bad.source).toBe('dropped_nonconforming');
    expect(bad.warnings.join(' ')).toMatch(/non-conforming/);

    // absent → none
    expect(acquireSelfReport('claude', undefined).source).toBe('none');
  });

  it('a dropped/missing self-report never blocks: result still valid + diff intact', () => {
    const r = buildDelegationResult({ cli: 'gemini', diff: DIFF_A, events: [completion(1, 1)], self_report_raw: { claimed_changes: 5 } });
    expect(r.self_report_source).toBe('dropped_nonconforming');
    expect(r.agent_self_report).toBeUndefined();
    expect(r.diff).toBe(DIFF_A);            // diff still authoritative + present
    expect(validateDelegationResult(r).ok).toBe(true);
  });

  // ── claim_vs_diff_mismatch_warns_not_fails ──
  it('claim_vs_diff_mismatch_warns_not_fails', () => {
    // agent UNDER-reports: changed a.ts + sub/b.ts but only claimed a.ts
    const r = buildDelegationResult({
      cli: 'claude',
      diff: DIFF_TWO,
      events: [completion(2, 2)],
      self_report_raw: { claimed_changes: ['a.ts'] },
    });
    expect(r.warnings.some((w) => /under-reported/.test(w))).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/sub\/b\.ts/);
    // mismatch is a WARNING, not a failure — the result is still structurally valid
    expect(validateDelegationResult(r).ok).toBe(true);

    // agent OVER-claims: claimed a file that the diff does not contain
    const lie = detectClaimMismatch(DIFF_A, ['a.ts', 'ghost.ts']);
    expect(lie.mismatch).toBe(true);
    expect(lie.over_claimed).toEqual(['ghost.ts']);
    expect(lie.under_reported).toEqual([]);

    // honest claim → no mismatch, no warning
    const honest = detectClaimMismatch(DIFF_TWO, ['a.ts', 'sub/b.ts']);
    expect(honest.mismatch).toBe(false);
    expect(honest.warnings).toEqual([]);

    // no claim → nothing to check (not a mismatch)
    expect(detectClaimMismatch(DIFF_A, undefined).mismatch).toBe(false);
  });

  it('validateDelegationResult rejects a missing authoritative diff', () => {
    const bad = { cli: 'claude', driver: 'headless', stop_reason: 'end_turn', tokens: { input: 0, output: 0 }, self_report_source: 'none', warnings: [] } as unknown;
    const v = validateDelegationResult(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/diff missing/);
  });

  it('carries kill metadata from a guarded run', () => {
    const r: DelegationResult = buildDelegationResult({
      cli: 'codex',
      diff: '',
      stop_reason: 'cancelled',
      tokens: { input: 0, output: 0 },
      killed: true,
      kill_reason: 'wall_clock',
    });
    expect(r.killed).toBe(true);
    expect(r.kill_reason).toBe('wall_clock');
    expect(r.stop_reason).toBe('cancelled');
    expect(validateDelegationResult(r).ok).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { loadCliModeTrace } from '../apps/api/src/cliModeTrace';

describe('STORY-034.6: CLI-mode trace endpoint — read-only projection of the real 034.5 run', () => {
  it('loads the recorded run by run_id or "latest"', () => {
    const t: any = loadCliModeTrace('latest');
    expect(t).toBeTruthy();
    expect(t.run_id).toMatch(/^cli_mode_claude_/);
    expect(loadCliModeTrace(t.run_id)).toBeTruthy();
  });

  it('exposes the isolation gates: Layer 2 (4 invariants held) + Layer 1 hardened proof + no-escape review', () => {
    const t: any = loadCliModeTrace('latest');
    expect(t.isolation.layer2.held).toBe(true);
    expect(t.isolation.layer2.invariants).toHaveLength(4);
    expect(t.isolation.layer2.invariants.every((i: any) => i.held)).toBe(true);
    expect(t.isolation.layer1.hardened_proof.proven).toBe(true);
    expect(t.isolation.layer1.hardened_proof.invariants).toHaveLength(4);
    // the honest 034.5 finding is preserved (this run bypassed the proxy)
    expect(t.isolation.layer1.this_run.egress_via_proxy).toBe(false);
    // real bash stream: a single Write; no escape attempts
    expect(t.isolation.bash_commands[0].tool).toBe('Write');
    expect(t.isolation.escape_attempts.every((e: any) => e.detected === false)).toBe(true);
  });

  it('exposes the story completion flow + the exit-gate verdict (diff authoritative)', () => {
    const t: any = loadCliModeTrace('latest');
    expect(t.completion.changed_files).toContain('slugify.mjs');
    expect(t.completion.exit_gate.verdict).toBe('ACCEPTED');
    expect(t.completion.exit_gate.out_of_write_set).toEqual([]);
    expect(t.completion.steps.map((s: any) => s.step)).toEqual(
      ['sandbox_created', 'claude_work', 'diff', 'exit_gate', 'result'],
    );
    expect(t.events.map((e: any) => e.kind)).toContain('tool_use');
  });

  it('returns null for an unknown run — no path traversal, read-only', () => {
    expect(loadCliModeTrace('../../etc/passwd')).toBeNull();
    expect(loadCliModeTrace('nope')).toBeNull();
  });
});

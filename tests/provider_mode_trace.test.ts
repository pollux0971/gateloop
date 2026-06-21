import { describe, it, expect, beforeAll } from 'vitest';
import { writeProviderModeTrace } from '../scripts/capture-provider-mode-trace.ts';
import { loadProviderModeTrace } from '../apps/api/src/providerModeTrace';

/**
 * EPIC-035 TIER C — the provider-mode cockpit trace (read-only projection of the provider path).
 *
 * beforeAll regenerates the committed fixture from the in-process provider-mode tool-layer pipeline
 * (zero cost, deterministic: scripted mediator + a content-hash-stable git diff), so the fixture
 * the cockpit and the web test read is always faithful to the live pipeline. Then we assert the
 * cockpit-relevant invariants + the read-only endpoint contract.
 */
beforeAll(async () => { await writeProviderModeTrace(); });

describe('EPIC-035 TIER C: provider-mode trace endpoint — read-only projection of the provider path', () => {
  it('loads the recorded run by run_id or "latest"', () => {
    const t: any = loadProviderModeTrace('latest');
    expect(t).toBeTruthy();
    expect(t.run_id).toMatch(/^provider_mode_/);
    expect(t.mode).toBe('provider_mode');
    expect(loadProviderModeTrace(t.run_id)).toBeTruthy();
  });

  it('exposes the tool-layer confinement: default-deny surface, no Bash, core no AI SDK, + the audit', () => {
    const t: any = loadProviderModeTrace('latest');
    const tl = t.isolation.tool_layer;
    expect(tl.default_deny).toBe(true);
    expect(tl.bash_available).toBe(false);
    expect(tl.core_imports_ai_sdk).toBe(false);
    expect(tl.surface).toContain('write_file');
    expect(tl.surface).not.toContain('bash');
    // the audit demonstrates allow-and-executed + an unexpected tool default-denied (executor never reached)
    expect(tl.audit.some((a: any) => a.tool === 'write_file' && a.decision === 'allow' && a.executed)).toBe(true);
    expect(tl.default_denials.length).toBeGreaterThanOrEqual(1);
  });

  it('exposes what the real metered model did: whitelist-only, zero breaches, default-deny not needed', () => {
    const t: any = loadProviderModeTrace('latest');
    const rr = t.isolation.real_run;
    expect(rr.metered).toBe(true);
    expect(rr.endpoint).toBe('api.openai.com');
    expect(rr.breaches).toBe(0);
    expect(rr.default_deny_triggered).toBe(false);
    expect(rr.tools_called).toEqual(['write_file', 'report']);
  });

  it('exposes the story completion flow + the exit-gate verdict (diff authoritative)', () => {
    const t: any = loadProviderModeTrace('latest');
    expect(t.completion.changed_files).toContain('slugify.mjs');
    expect(t.completion.exit_gate.verdict).toBe('ACCEPTED');
    expect(t.completion.exit_gate.out_of_write_set).toEqual([]);
    expect(t.completion.steps.map((s: any) => s.step)).toEqual(
      ['sandbox_created', 'model_work', 'diff', 'exit_gate', 'result'],
    );
    expect(t.events.map((e: any) => e.kind)).toContain('tool_call');
  });

  it('returns null for an unknown run — no path traversal, read-only', () => {
    expect(loadProviderModeTrace('../../etc/passwd')).toBeNull();
    expect(loadProviderModeTrace('nope')).toBeNull();
  });
});

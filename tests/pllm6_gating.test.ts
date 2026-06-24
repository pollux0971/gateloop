/**
 * STORY-PLLM.6 — OFFLINE gating guard (runs in CI, ZERO spend).
 *
 * Proves the gated runner is opt-in / never-in-CI and the kill-switch is reachable —
 * WITHOUT any real provider call. The real run itself (the spend) is fired by the operator
 * via the runner's CLI with PLLM6_REAL=1; its evidence lives in docs/PLLM6_REAL_RUN_REPORT.md,
 * not here. The runner is `tests/pllm6_real_epics_run.ts` (NOT a *.test.ts), so it is never
 * collected by vitest.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runRealEpics, renderReport, type RealRunReport } from './pllm6_real_epics_run';
import { createScriptedEngine } from '@gateloop/provider-driver';
import type { RealAuthorDeps } from '@gateloop/planning-steward';

const REPO = path.resolve(__dirname, '..'); // gateloop/

/** A real-author deps backed by a provider-driver SCRIPTED engine — zero spend. Records
 *  how many times the engine was built (a proxy for "would have called the provider"). */
function scriptedAuthorDeps(text: string): { deps: RealAuthorDeps; builds: () => number } {
  let builds = 0;
  const deps: RealAuthorDeps = {
    buildEngine: async () => {
      builds++;
      return createScriptedEngine({
        parts: [
          { type: 'text-delta', text },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
      });
    },
  };
  return { deps, builds: () => builds };
}

describe('STORY-PLLM.6 — gated real-run guard (offline, zero spend)', () => {
  it('real_run_is_opt_in_never_in_ci_kill_switch_reachable', async () => {
    const { deps, builds } = scriptedAuthorDeps('x');

    // (1) opt-in: optIn:false refuses to run and NEVER builds an engine / calls a provider.
    await expect(
      runRealEpics({ repo: REPO, realAuthorDeps: deps, idea: 'i', optIn: false }),
    ).rejects.toThrow(/opt-in/i);
    expect(builds()).toBe(0);

    // (2) kill-switch: a pre-aborted signal stops before any stage → no engine build / no spend.
    const aborted = new AbortController();
    aborted.abort();
    const killed = await runRealEpics({ repo: REPO, realAuthorDeps: deps, idea: 'i', optIn: true, signal: aborted.signal });
    expect(killed.aborted).toBe(true);
    expect(killed.stages.length).toBe(0);
    expect(builds()).toBe(0); // kill-switch reachable: nothing was authored

    // (3) never in CI: the runner module exists but is not a test file (vitest only
    // collects names ending in ".test.ts", so it is never run by the suite).
    const runnerPath = path.join(__dirname, 'pllm6_real_epics_run.ts');
    expect(fs.existsSync(runnerPath)).toBe(true);
    expect(path.basename(runnerPath)).not.toMatch(/\.test\.ts$/);
  });

  it('runner_drives_the_pipeline_through_the_real_author_seam_offline', async () => {
    // With opt-in + a scripted engine, the runner DOES drive the pipeline via the real-author
    // seam (mode:'real') — proving the wiring works end-to-end with zero spend. The brief
    // stage advances (ungated); the prd stage is authored via the (scripted) engine.
    const { deps, builds } = scriptedAuthorDeps('# PRD\n## Overview\nx\n');
    const report = await runRealEpics({ repo: REPO, realAuthorDeps: deps, idea: 'A tiny URL shortener.', optIn: true, maxStages: 3 });
    expect(report.aborted).toBe(false);
    expect(report.stages[0].stageId).toBe('brief');
    expect(report.stages[0].advanced).toBe(true); // brief is ungated
    // a skill stage was reached and the real-author engine was built (provider seam used).
    expect(report.stages.length).toBeGreaterThanOrEqual(2);
    expect(builds()).toBeGreaterThanOrEqual(1);
  });

  it('report_renders_token_cost_note_and_never_includes_a_key', () => {
    const report: RealRunReport = {
      ok: true, aborted: false, idea: 'A tiny URL shortener.',
      stages: [{ stageId: 'epics', advanced: true, attempts: 1, docLength: 42, docPreview: '# Epics\n- STORY-1', failingItems: [] }],
      epicsDoc: '# Epics\n- STORY-1: do the thing',
    };
    const md = renderReport(report, { backendId: 'openai', model: 'gpt-4o-mini', calls: 4, inputTokens: 1200, outputTokens: 800 }, '2026-06-25T00:00:00Z');
    expect(md).toContain('Token / cost note');
    expect(md).toContain('Provider calls: 4');
    expect(md).toContain('Input tokens: 1200');
    expect(md).toContain('Produced epics artifact');
    // single-variable framing: exactly one idea recorded.
    expect(md).toContain('single variable');
    // a key must never appear in a rendered report.
    expect(md).not.toMatch(/sk-[a-z0-9]/i);
  });
});

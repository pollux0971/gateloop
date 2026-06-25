/**
 * Cockpit read helpers (apps/api/src/cockpit.ts) — make every console page live.
 * Read-only over the live configs + sibling builder/ tracker + api fixtures, each tagged
 * source:'live'|'sample'. Asserted against the REAL repo (helpers never write) plus a
 * synthetic temp tracker for deterministic pipeline derivation + the missing-builder fallback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readGates, readBacklog, derivePipeline, readCheckpoints, readBudget,
  readQualityBar, readFailureBank, readHumanGates, readReviewerDirections, type CockpitCtx,
} from '../apps/api/src/cockpit';

const REAL = path.resolve(__dirname, '..');                       // gateloop/
const liveCtx: CockpitCtx = {
  repo: REAL,
  builder: path.join(REAL, '..', 'builder'),
  fixtures: path.join(REAL, 'apps', 'api', 'fixtures'),
};
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tempBuilder(tracker: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-cockpit-'));
  tmps.push(root);
  fs.mkdirSync(path.join(root, 'tracker'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tracker', 'tracker_state.json'), JSON.stringify(tracker));
  return root;
}

describe('cockpit reads — live config/tracker sources', () => {
  it('readGates: 4 gates, real_api_calls human-only and read-only (no toggle path)', () => {
    const g = readGates(liveCtx);
    expect(g.source).toBe('live');
    expect(g.gates.map((x) => x.id)).toEqual(
      ['real_api_calls', 'sudo_broker_runtime', 'bypass_workspace_runtime', 'stable_promotion'],
    );
    const rac = g.gates.find((x) => x.id === 'real_api_calls')!;
    expect(rac.human_only).toBe(true);
    expect(rac.enabled).toBe(false);              // policy.yaml is CLOSED
    expect(rac.note).toMatch(/cockpit cannot toggle/i);
    for (const x of g.gates) expect(x.human_only).toBe(true);
  });

  it('readBacklog: live tracker stories + counts', () => {
    const b = readBacklog(liveCtx);
    // Fresh gh clone: the sibling builder/ is dev-only and excluded from the published
    // subtree, so the live source isn't present. Assert the documented graceful fallback
    // (mirrors the 'missing builder/ → graceful sample fallback' test below). With builder/
    // present (dev workspace) the full live assertions still run.
    if (!fs.existsSync(liveCtx.builder)) {
      expect(b.source).toBe('sample');
      expect(b.stories).toEqual([]);
      return;
    }
    expect(b.source).toBe('live');
    expect(b.stories.length).toBeGreaterThan(0);
    expect(Object.keys(b.counts).length).toBeGreaterThan(0);
    expect(b.stories[0]).toHaveProperty('story_id');
    expect(b.stories[0]).toHaveProperty('status');
  });

  it('readBudget: caps live from settings.yaml, usage flagged sample', () => {
    const r = readBudget(liveCtx);
    expect(r.caps_source).toBe('live');
    expect(r.caps.per_run_tokens).toBe(1500000);  // settings.yaml budget.max_tokens_per_run
    expect(r.usage_source).toBe('sample');
    expect(typeof (r.usage as { tokens: number }).tokens).toBe('number');
  });

  it('readQualityBar: required_checks + review live', () => {
    const r = readQualityBar(liveCtx);
    expect(r.required_checks).toContain('build');
    expect((r.review as { cross_model?: boolean }).cross_model).toBe(true);
  });

  it('readFailureBank: governance live, genes sample', () => {
    const r = readFailureBank(liveCtx);
    expect((r.governance as { recurring_pattern_threshold?: number }).recurring_pattern_threshold).toBe(2);
    expect(r.genes_source).toBe('sample');
    expect(r.genes.length).toBeGreaterThan(0);
  });

  it('readHumanGates + readCheckpoints + readReviewerDirections: sample fallbacks render', () => {
    expect(readHumanGates(liveCtx).gates.length).toBeGreaterThan(0);
    expect(readCheckpoints(liveCtx).checkpoints.length).toBeGreaterThan(0);
    expect(readReviewerDirections(liveCtx, 'STORY-009.3').directions.length).toBeGreaterThan(0);
  });
});

describe('cockpit derivation + fallback', () => {
  it('derivePipeline: lanes by status, waves by depends_on, admission from blocked_reason', () => {
    const builder = tempBuilder({
      stories: [
        { story_id: 'A', status: 'todo', depends_on: [] },
        { story_id: 'B', status: 'in_progress', depends_on: ['A'] },
        { story_id: 'C', status: 'blocked', depends_on: ['B'], blocked_reason: 'dep blocked', parallelism_class: 'sequential' },
        { story_id: 'D', status: 'checkpointed', depends_on: ['A'] },
      ],
      run: { active: true, scope: 'TEST' },
    });
    const p = derivePipeline({ ...liveCtx, builder });
    expect(p.source).toBe('live');
    expect(p.lanes.todo.map((s) => s.story_id)).toEqual(['A']);
    expect(p.lanes.in_progress.map((s) => s.story_id)).toEqual(['B']);
    expect(p.lanes.blocked.map((s) => s.story_id)).toEqual(['C']);
    expect(p.lanes.done.map((s) => s.story_id)).toEqual(['D']);   // checkpointed → done lane
    expect(p.waves['0']).toContain('A');                           // no deps → wave 0
    expect(p.waves['2']).toContain('C');                           // A→B→C → wave 2
    expect(p.admission).toEqual([
      { story_id: 'C', status: 'blocked', reason: 'dep blocked', parallelism_class: 'sequential' },
    ]);
  });

  it('missing builder/ → graceful sample fallback, not a throw', () => {
    const b = readBacklog({ ...liveCtx, builder: '/nonexistent/builder' });
    expect(b.source).toBe('sample');
    expect(b.stories).toEqual([]);
    // pipeline over a missing tracker is also safe
    expect(derivePipeline({ ...liveCtx, builder: '/nonexistent/builder' }).source).toBe('sample');
  });
});

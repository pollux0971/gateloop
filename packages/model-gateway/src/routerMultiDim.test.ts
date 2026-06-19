/**
 * WORK C — the multi-dimensional cost-adjusted router: Maximize P(success) − λ·cost
 * over the registry, matching complexity + domain + context. Deterministic (no LLM):
 * same task + registry + λ → same model. The decision carries per-candidate scores +
 * a rationale for the trace.
 */
import { describe, it, expect } from 'vitest';
import {
  selectModelCostAdjusted, resolveModelMultiDim, multiDimTaskFromPacket,
  type ModelEntry, type RoutingConfig, type MultiDimTask,
} from './index';

// Test registry: flash/pro have SMALL windows (< the 100k long-context threshold) so the
// long-context dimension is decisive when a task needs it; big-ctx is the only one that fits.
const REGISTRY: ModelEntry[] = [
  { name: 'flash', kind: 'openai', pricing: { input: 0.14, output: 0.28 }, capabilities: ['code-generation', 'frontend'], context_window: 32000 },
  { name: 'pro', kind: 'openai', pricing: { input: 0.435, output: 0.87 }, capabilities: ['code-generation', 'debugging', 'backend'], context_window: 80000 },
  { name: 'big-ctx', kind: 'openai', pricing: { input: 1.0, output: 2.0 }, capabilities: ['code-generation', 'backend', 'long-context'], context_window: 1000000 },
];

const task = (t: Partial<MultiDimTask>): MultiDimTask =>
  ({ complexity: 'medium', required_capability: 'code-generation', ...t });

describe('WORK C — multi-dimensional selection picks the right model', () => {
  it('a FRONTEND trivial task → the frontend-capable cheap model (flash), not a backend model', () => {
    const d = selectModelCostAdjusted(task({ complexity: 'trivial', domains: ['frontend'] }), REGISTRY, 0.5)!;
    expect(d.model).toBe('flash');
  });

  it('a NEEDS-LONG-CONTEXT large task → the long-context model (big-ctx), despite higher cost', () => {
    const d = selectModelCostAdjusted(task({ complexity: 'large', domains: ['backend'], needs_long_context: true }), REGISTRY, 0.5)!;
    expect(d.model).toBe('big-ctx');
  });

  it('a SIMPLE backend additive task → the cheap model (flash)', () => {
    const d = selectModelCostAdjusted(task({ complexity: 'trivial', domains: ['backend'] }), [REGISTRY[0], REGISTRY[1]], 0.5)!;
    expect(d.model).toBe('flash');
  });

  it('a COMPLEX backend task → the strong model (pro)', () => {
    const d = selectModelCostAdjusted(task({ complexity: 'large', domains: ['backend'] }), [REGISTRY[0], REGISTRY[1]], 0.5)!;
    expect(d.model).toBe('pro');
  });

  it('debugging filters to capable models only', () => {
    const d = selectModelCostAdjusted(task({ required_capability: 'debugging', complexity: 'medium' }), REGISTRY, 0.5)!;
    expect(['pro', 'big-ctx']).toContain(d.model);          // flash lacks 'debugging'
  });

  it('no capable model → null', () => {
    expect(selectModelCostAdjusted(task({ required_capability: 'video' }), REGISTRY, 0.5)).toBeNull();
  });
});

describe('WORK C — λ shifts the optimum (save-money ↔ reliable)', () => {
  it('HIGH λ favors the cheaper model on a complex task; LOW λ favors the stronger one', () => {
    const t = task({ complexity: 'large', domains: ['backend'] });
    const cheap = selectModelCostAdjusted(t, [REGISTRY[0], REGISTRY[1]], 1.5)!;   // λ high → cost dominates
    const strong = selectModelCostAdjusted(t, [REGISTRY[0], REGISTRY[1]], 0.05)!; // λ low → P dominates
    expect(cheap.model).toBe('flash');
    expect(strong.model).toBe('pro');
  });
});

describe('WORK C — reproducible + rationale for the trace', () => {
  it('same task + registry + λ → identical decision (deterministic)', () => {
    const t = task({ complexity: 'large', domains: ['backend'], needs_long_context: true });
    expect(selectModelCostAdjusted(t, REGISTRY, 0.5)).toEqual(selectModelCostAdjusted(t, REGISTRY, 0.5));
  });

  it('the decision carries per-candidate scores and a readable rationale', () => {
    const d = selectModelCostAdjusted(task({ complexity: 'large', domains: ['backend'] }), REGISTRY, 0.5)!;
    expect(d.scores.length).toBe(3);
    expect(d.scores[0]).toHaveProperty('p_success');
    expect(d.scores[0]).toHaveProperty('score');
    expect(d.rationale).toMatch(/picked '.*': P\(success\)/);
  });
});

describe('WORK C — opt-in resolver + packet adapter (the Supervisor call point)', () => {
  const ROUTING: RoutingConfig = { agents: { developer: { primary: 'pro', fallbacks: [] } } };

  it('router OFF → static routing (no decision)', () => {
    const r = resolveModelMultiDim(ROUTING, 'developer', 'patch_generation', { routerEnabled: false });
    expect(r.source).toBe('static');
    expect(r.names).toEqual(['pro']);
  });

  it('router ON → multi-dim pick first, decision attached', () => {
    const r = resolveModelMultiDim(ROUTING, 'developer', 'patch_generation', {
      routerEnabled: true, lambda: 0.5, models: REGISTRY,
      task: { complexity: 'trivial', required_capability: 'code-generation', domains: ['frontend'] },
    });
    expect(r.source).toBe('router');
    expect(r.names[0]).toBe('flash');
    expect(r.decision!.rationale).toBeTruthy();
  });

  it('multiDimTaskFromPacket reads task_signals + complexity + target_agent', () => {
    const t = multiDimTaskFromPacket({ target_agent: 'developer', estimated_complexity: 'large', task_signals: { domains: ['backend'], needs_long_context: true } });
    expect(t).toEqual({ complexity: 'large', required_capability: 'code-generation', domains: ['backend'], needs_long_context: true });
    expect(multiDimTaskFromPacket({ target_agent: 'debugger', task_signals: {} }).required_capability).toBe('debugging');
  });
});

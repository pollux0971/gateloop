/**
 * WORK 3c — the deterministic router. selectModelForTask picks a model from the
 * registry using capabilities + complexity + pricing, reproducibly (no LLM). It is
 * opt-in via resolveModelWithRouter (static routing stays the fallback) and emits a
 * decision the caller writes to the trace.
 */
import { describe, it, expect } from 'vitest';
import {
  selectModelForTask, resolveModelWithRouter,
  type ModelEntry, type RoutingConfig,
} from './index';

const REGISTRY: ModelEntry[] = [
  { name: 'gpt-5.4-mini', kind: 'openai', pricing: { input: 0.75, output: 4.5 }, capabilities: ['planning', 'review', 'assessment'] },
  { name: 'deepseek-v4-pro', kind: 'openai', pricing: { input: 0.435, output: 0.87 }, capabilities: ['code-generation', 'debugging'] },
  { name: 'deepseek-v4-flash', kind: 'openai', pricing: { input: 0.14, output: 0.28 }, capabilities: ['code-generation'] },
];

describe('WORK 3c — selectModelForTask is capability-filtered, complexity-tiered, reproducible', () => {
  it('large code-generation → the STRONGEST capable model (deepseek-v4-pro)', () => {
    const d = selectModelForTask({ complexity: 'large', required_capability: 'code-generation', models: REGISTRY })!;
    expect(d.model).toBe('deepseek-v4-pro');
    expect(d.reason).toMatch(/strongest/);
    expect(d.considered.sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
  });

  it('trivial code-generation → the CHEAPEST capable model (deepseek-v4-flash)', () => {
    const d = selectModelForTask({ complexity: 'trivial', required_capability: 'code-generation', models: REGISTRY })!;
    expect(d.model).toBe('deepseek-v4-flash');
    expect(d.reason).toMatch(/cheapest/);
  });

  it('debugging → only the capable model (deepseek-v4-pro); gpt/flash lack the capability', () => {
    const d = selectModelForTask({ complexity: 'medium', required_capability: 'debugging', models: REGISTRY })!;
    expect(d.model).toBe('deepseek-v4-pro');
    expect(d.considered).toEqual(['deepseek-v4-pro']);
  });

  it('is REPRODUCIBLE — same input yields the same decision (not random)', () => {
    const a = selectModelForTask({ complexity: 'large', required_capability: 'code-generation', models: REGISTRY });
    const b = selectModelForTask({ complexity: 'large', required_capability: 'code-generation', models: REGISTRY });
    expect(a).toEqual(b);
  });

  it('no capable model → null (caller falls back to static)', () => {
    expect(selectModelForTask({ complexity: 'large', required_capability: 'video', models: REGISTRY })).toBeNull();
  });
});

describe('WORK 3c — resolveModelWithRouter is opt-in (static is the fallback)', () => {
  const ROUTING: RoutingConfig = { agents: { developer: { primary: 'deepseek-v4-pro', fallbacks: ['gpt-5.4-mini'] } } };

  it('router OFF → static routing unchanged (no decision)', () => {
    const r = resolveModelWithRouter(ROUTING, 'developer', 'patch_generation', { routerEnabled: false });
    expect(r.source).toBe('static');
    expect(r.names).toEqual(['deepseek-v4-pro', 'gpt-5.4-mini']);
    expect(r.decision).toBeUndefined();
  });

  it('router ON for a TRIVIAL story → picks the cheap model first, emits a decision', () => {
    const r = resolveModelWithRouter(ROUTING, 'developer', 'patch_generation', {
      routerEnabled: true, complexity: 'trivial', required_capability: 'code-generation', models: REGISTRY,
    });
    expect(r.source).toBe('router');
    expect(r.names[0]).toBe('deepseek-v4-flash');         // cheaper than the static primary
    expect(r.decision!.reason).toMatch(/cheapest/);        // decision is auditable (→ trace)
  });

  it('router ON but nothing capable → clean fallback to static (never fails closed)', () => {
    const r = resolveModelWithRouter(ROUTING, 'developer', 'patch_generation', {
      routerEnabled: true, complexity: 'large', required_capability: 'video', models: REGISTRY,
    });
    expect(r.source).toBe('static');
    expect(r.names).toEqual(['deepseek-v4-pro', 'gpt-5.4-mini']);
  });
});

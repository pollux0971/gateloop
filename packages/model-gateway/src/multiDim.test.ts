/**
 * WORK A — multi-dimensional model capabilities (domain + long-context) and
 * context_window are additive registry fields the multi-dim router (WORK C) matches
 * against a task. Accepted but never required. CI-safe, no model.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateModelRegistryV2, type ModelEntry, type RoutingConfig } from './index';

const ROUTING: RoutingConfig = { agents: { developer: { primary: 'coder', fallbacks: [] } } };

describe('WORK A — context_window + domain/long-context capabilities are additive', () => {
  it('a model with context_window + frontend/backend/long-context validates', () => {
    const models: ModelEntry[] = [{
      name: 'coder', kind: 'openai', base_url: 'https://x',
      capabilities: ['code-generation', 'backend', 'long-context'], context_window: 256000,
    }];
    expect(validateModelRegistryV2(models, ROUTING).ok).toBe(true);
  });

  it('a model without them still validates (no regression)', () => {
    expect(validateModelRegistryV2([{ name: 'coder', kind: 'openai', base_url: 'https://x' }], ROUTING).ok).toBe(true);
  });
});

describe('WORK A — the real models.yaml carries the multi-dimensional signals', () => {
  const models: ModelEntry[] = parseYaml(fs.readFileSync('configs/models.yaml', 'utf8')).models;
  const by = (n: string) => models.find(m => m.name === n)!;

  it('deepseek-v4-pro is backend with a context window', () => {
    expect(by('deepseek-v4-pro').capabilities).toContain('backend');
    expect(by('deepseek-v4-pro').context_window).toBe(128000);
  });
  it('deepseek-v4-flash is frontend', () => {
    expect(by('deepseek-v4-flash').capabilities).toContain('frontend');
  });
  it('codex-subscription is long-context', () => {
    expect(by('codex-subscription').capabilities).toContain('long-context');
    expect(by('codex-subscription').context_window).toBeGreaterThanOrEqual(200000);
  });
});

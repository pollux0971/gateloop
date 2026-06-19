/**
 * WORK 1 — model description/capabilities/vendor are additive registry fields the
 * deterministic router (WORK 3) and the registry UI read. They must be accepted but
 * never required (existing pricing-only models keep validating). CI-safe, no model.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateModelRegistryV2, type ModelEntry, type RoutingConfig } from './index';

const ROUTING: RoutingConfig = { agents: { developer: { primary: 'coder', fallbacks: [] } } };

describe('WORK 1 — description/capabilities/vendor are additive', () => {
  it('a model WITH description/capabilities/vendor validates', () => {
    const models: ModelEntry[] = [{
      name: 'coder', kind: 'openai', base_url: 'https://x',
      vendor: 'DeepSeek', description: 'strong code generation', capabilities: ['code-generation', 'debugging'],
    }];
    expect(validateModelRegistryV2(models, ROUTING).ok).toBe(true);
  });

  it('a model WITHOUT them still validates (additive — no regression)', () => {
    const models: ModelEntry[] = [{ name: 'coder', kind: 'openai', base_url: 'https://x' }];
    expect(validateModelRegistryV2(models, ROUTING).ok).toBe(true);
  });
});

describe('WORK 1 — the real models.yaml carries router-readable capabilities', () => {
  const models: ModelEntry[] = parseYaml(fs.readFileSync('configs/models.yaml', 'utf8')).models;
  const by = (n: string) => models.find(m => m.name === n)!;

  it('deepseek-v4-pro describes code-generation + debugging', () => {
    expect(by('deepseek-v4-pro').capabilities).toContain('code-generation');
    expect(by('deepseek-v4-pro').capabilities).toContain('debugging');
    expect(by('deepseek-v4-pro').description).toMatch(/code/i);
  });

  it('gpt-5.4-mini describes planning/judgement', () => {
    expect(by('gpt-5.4-mini').capabilities).toContain('planning');
    expect(by('gpt-5.4-mini').vendor).toBe('OpenAI');
  });

  it('the real registry still validates against the live routing', () => {
    const routing: RoutingConfig = parseYaml(fs.readFileSync('configs/model_routing.yaml', 'utf8'));
    expect(validateModelRegistryV2(models, routing).ok).toBe(true);
  });
});

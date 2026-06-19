/**
 * UI WORK 2 — the /api/models + /api/routing backend. The helpers read the LIVE
 * configs/models.yaml + model_routing.yaml (so the cockpit shows real data, not mock)
 * and apply an agent→model change in place, validating model+agent and preserving
 * YAML comments. Tested against a temp copy so the real configs are never mutated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readModels, readRouting, routingRows, applyRoutingUpdate } from '../apps/api/src/registry';

const REAL = path.resolve(__dirname, '..');     // gateloop/
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A throwaway repo with a copy of the live configs, so writes never touch the real files. */
function tempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-registry-'));
  tmps.push(root);
  fs.mkdirSync(path.join(root, 'configs'));
  for (const f of ['models.yaml', 'model_routing.yaml']) {
    fs.copyFileSync(path.join(REAL, 'configs', f), path.join(root, 'configs', f));
  }
  return root;
}

describe('WORK 2 — GET serves the LIVE registry (not mock)', () => {
  it('readModels returns real models with the WORK 1 capabilities', () => {
    const models = readModels(REAL);
    const pro = models.find(m => m.name === 'deepseek-v4-pro')!;
    expect(pro.capabilities).toContain('code-generation');
    expect(pro.description).toBeTruthy();
  });

  it('routingRows lists every agent with its assigned model', () => {
    const rows = routingRows(readRouting(REAL));
    const agents = rows.map(r => r.agent);
    expect(agents).toContain('developer');
    expect(agents).toContain('supervisor');
    expect(rows.find(r => r.agent === 'developer')!.model).toBeTruthy();
  });
});

describe('WORK 2 — PUT /api/routing writes the yaml safely', () => {
  it('reassigns an agent model in place and preserves comments', () => {
    const repo = tempRepo();
    const before = fs.readFileSync(path.join(repo, 'configs/model_routing.yaml'), 'utf8');
    expect(before).toMatch(/#/);                                  // file has comments

    const r = applyRoutingUpdate(repo, 'developer', 'deepseek-v4-flash');
    expect(r.ok).toBe(true);

    const after = fs.readFileSync(path.join(repo, 'configs/model_routing.yaml'), 'utf8');
    expect(routingRows(readRouting(repo)).find(x => x.agent === 'developer')!.model).toBe('deepseek-v4-flash');
    expect(after).toMatch(/#/);                                   // comments preserved
  });

  it('rejects an unknown model (validation, no write)', () => {
    const repo = tempRepo();
    const r = applyRoutingUpdate(repo, 'developer', 'no-such-model');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown model/);
    expect(routingRows(readRouting(repo)).find(x => x.agent === 'developer')!.model).not.toBe('no-such-model');
  });

  it('rejects an unknown agent', () => {
    const repo = tempRepo();
    expect(applyRoutingUpdate(repo, 'no-such-agent', 'deepseek-v4-pro').error).toMatch(/unknown agent/);
  });
});

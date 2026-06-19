/**
 * WORK D — router config backend: on/off + a plain-language mode that maps to the
 * router's cost weight λ INTERNALLY (the UI never sees λ). Validates the mode and
 * preserves comments on write. Tested against a temp copy.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRouterConfig, applyRouterConfig, lambdaForMode } from '../apps/api/src/registry';

const REAL = path.resolve(__dirname, '..');
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-router-'));
  tmps.push(root);
  fs.mkdirSync(path.join(root, 'configs'));
  fs.copyFileSync(path.join(REAL, 'configs', 'router_config.yaml'), path.join(root, 'configs', 'router_config.yaml'));
  return root;
}

describe('WORK D — router config read/write', () => {
  it('reads the default config', () => {
    const cfg = readRouterConfig(REAL);
    expect(cfg.enabled).toBe(false);
    expect(['save-money', 'balanced', 'reliable']).toContain(cfg.mode);
  });

  it('mode maps to an internal λ (save-money > balanced > reliable)', () => {
    expect(lambdaForMode('save-money')).toBeGreaterThan(lambdaForMode('balanced'));
    expect(lambdaForMode('balanced')).toBeGreaterThan(lambdaForMode('reliable'));
  });

  it('enables the router and sets a mode in place (comments preserved)', () => {
    const repo = tempRepo();
    const r = applyRouterConfig(repo, { enabled: true, mode: 'save-money' });
    expect(r.ok).toBe(true);
    expect(readRouterConfig(repo)).toEqual({ enabled: true, mode: 'save-money' });
    expect(fs.readFileSync(path.join(repo, 'configs/router_config.yaml'), 'utf8')).toMatch(/#/);
  });

  it('rejects an invalid mode', () => {
    const repo = tempRepo();
    const r = applyRouterConfig(repo, { mode: 'turbo' as never });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid mode/);
  });
});

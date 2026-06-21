import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveCodegraphBin,
  engineAvailable,
  indexSmoke,
  fixtureClient,
} from './index';

// The dead client's hardcoded path — the anti-pattern this story exists to avoid.
const DEAD_HARDCODED = '/data/python/codegraph_engine';

describe('STORY-CW.1: robust binary resolution (no hardcoded path)', () => {
  it('honours an explicit CODEGRAPH_BIN override (binary)', () => {
    const r = resolveCodegraphBin({ CODEGRAPH_BIN: '/opt/cg/codegraph' } as NodeJS.ProcessEnv);
    expect(r).toEqual({ command: '/opt/cg/codegraph', baseArgs: [], source: 'env' });
  });

  it('runs a `.js` CODEGRAPH_BIN override via the current node', () => {
    const r = resolveCodegraphBin({ CODEGRAPH_BIN: '/opt/cg/codegraph.js' } as NodeJS.ProcessEnv);
    expect(r?.source).toBe('env');
    expect(r?.command).toBe(process.execPath);
    expect(r?.baseArgs).toEqual(['/opt/cg/codegraph.js']);
  });

  it('returns null when nothing is resolvable (empty PATH, no override) — caller falls back to fixture/NULL', () => {
    const r = resolveCodegraphBin({ PATH: '' } as NodeJS.ProcessEnv);
    expect(r).toBeNull();
  });

  it('NEVER yields the dead hardcoded engine path, under any resolution outcome', () => {
    for (const env of [
      { CODEGRAPH_BIN: '/opt/cg/codegraph' },
      { CODEGRAPH_BIN: '/opt/cg/codegraph.js' },
      { PATH: '' },
      process.env,
    ] as NodeJS.ProcessEnv[]) {
      const r = resolveCodegraphBin(env);
      if (r) {
        expect(r.command).not.toContain(DEAD_HARDCODED);
        expect(r.baseArgs.join(' ')).not.toContain(DEAD_HARDCODED);
      }
    }
  });
});

describe('STORY-CW.1: fixture client implements the adapter seam (CI-safe, no engine)', () => {
  it('answers impact + symbol_lookup from the fixture spec', async () => {
    const c = fixtureClient({
      impact: { 'a.ts': ['b.ts', 'c.ts'] },
      symbols: { add: [{ file: 'math.ts', line: 1, kind: 'function' }] },
    });
    expect(c.backend).toBe('fixture');
    const imp = await c.query({ operation: 'impact', target: 'a.ts' });
    expect(imp.impacted_files).toEqual(['b.ts', 'c.ts']);
    const sym = await c.query({ operation: 'symbol_lookup', target: 'add' });
    expect(sym.locations).toEqual([{ file: 'math.ts', line: 1, kind: 'function' }]);
  });
});

// ── The real-index smoke: proves the engine is usable from GateLoop (local CPU, zero API). ──
// Skipped automatically when the engine is not installed (CI), so the suite stays green either way.
const ENGINE = engineAvailable();

describe.skipIf(!ENGINE)('STORY-CW.1: real-index smoke (engine present — local, zero API cost)', () => {
  it('builds a .codegraph index over a fixture repo and a query returns structured JSON', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cw1-smoke-'));
    try {
      fs.writeFileSync(path.join(ws, 'math.ts'), 'export function add(a: number, b: number){ return a + b; }\n');
      fs.writeFileSync(path.join(ws, 'app.ts'), "import { add } from './math';\nexport function compute(x: number){ return add(x, 1); }\n");

      const smoke = indexSmoke(ws, 'add');

      // resolution was robust (PATH/npx/env) and not the dead hardcoded path
      expect(['path', 'npx', 'env']).toContain(smoke.resolved.source);
      expect(smoke.resolved.command).not.toContain(DEAD_HARDCODED);
      // the engine built a real, populated index
      expect(smoke.indexBuilt).toBe(true);
      expect(smoke.statusInitialized).toBe(true);
      expect(smoke.nodeCount).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(ws, '.codegraph'))).toBe(true);
      // the query returned structured JSON locating the symbol in math.ts
      expect(smoke.queryHitFiles).toContain('math.ts');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);
});

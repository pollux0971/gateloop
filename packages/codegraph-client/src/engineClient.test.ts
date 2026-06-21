import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lookupSymbol, computeImpactSet, NULL_CLIENT } from '@gateloop/codegraph-adapter';
import { engineClient, engineAvailable, buildIndex, exportedSymbols } from './index';

// ── NULL fallback (always runs; CI / no-engine path must still work) ─────────────────
describe('STORY-CW.2: NULL fallback preserved (CI / no engine)', () => {
  it('lookupSymbol + computeImpactSet over NULL_CLIENT return empty (no throw)', async () => {
    const sym = await lookupSymbol('add', NULL_CLIENT);
    expect(sym.locations).toEqual([]);
    const imp = await computeImpactSet(['math.ts'], NULL_CLIENT);
    expect(imp.impactedFiles).toEqual([]);
  });

  it('exportedSymbols parses ESM exports', () => {
    expect(exportedSymbols('export function add(){}\nexport const x = 1;').sort()).toEqual(['add', 'x']);
    expect(exportedSymbols('export { foo, bar as baz }')).toContain('foo');
  });
});

// ── Real engine: every adapter op runs over the engine (local CPU, zero API) ─────────
const ENGINE = engineAvailable();
let ws = '';

describe.skipIf(!ENGINE)('STORY-CW.2: all adapter ops over the real engine', () => {
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cw2-'));
    fs.writeFileSync(path.join(ws, 'math.ts'),
      'export function add(a: number, b: number){ return a + b; }\nexport function double(x: number){ return add(x, x); }\n');
    fs.writeFileSync(path.join(ws, 'app.ts'),
      "import { double } from './math';\nexport function run(n: number){ return double(n) + double(n); }\n");
    buildIndex(ws);
  });
  afterAll(() => { if (ws) fs.rmSync(ws, { recursive: true, force: true }); });

  it('symbol_lookup is REVIVED — lookupSymbol returns a real file:line definition (not zero)', async () => {
    const r = await lookupSymbol('add', engineClient({ wsRoot: ws }));
    expect(r.locations.length).toBeGreaterThan(0);
    const def = r.locations.find((l) => l.kind === 'definition');
    expect(def?.file).toBe('math.ts');
    expect(def?.line).toBeGreaterThan(0);
    // the adapter's summary reflects the real definitions found
    expect(r.summary).toMatch(/definition/);
  });

  it('computeImpactSet over the real engine returns real dependents (math.ts → app.ts)', async () => {
    const r = await computeImpactSet(['math.ts'], engineClient({ wsRoot: ws }));
    expect(r.impactedFiles).toContain('app.ts');
    expect(r.impactedFiles).not.toContain('math.ts'); // the source file itself is excluded
  });

  it('dependents (callers) + dependencies (callees) + callgraph return real structured results', async () => {
    const c = engineClient({ wsRoot: ws });
    const callers = await c.query({ operation: 'dependents', target: 'double' });
    expect(callers.impacted_files).toContain('app.ts'); // run() calls double()
    const callees = await c.query({ operation: 'dependencies', target: 'run' });
    expect(callees.impacted_files).toContain('math.ts'); // run() calls double() in math.ts
    const cg = await c.query({ operation: 'callgraph', target: 'double' });
    expect(cg.impacted_files!.length).toBeGreaterThan(0);
  });
});

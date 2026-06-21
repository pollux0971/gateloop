import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { providerToolSet, type CodegraphBackend } from '@gateloop/tool-interface';
import { ConfinedToolMediator, codegraphBackendFromClient, assertToolLayerConfinementBarrier } from './index';
import type { CodeGraphClient } from '@gateloop/codegraph-adapter';
import { engineClient, engineAvailable, buildIndex } from '@gateloop/codegraph-client';

// A fixture backend (no engine) for the surface/default-deny checks.
const fixtureBackend: CodegraphBackend = {
  async query(operation, args) {
    return { summary: `fixture ${operation} ${String((args as { target?: unknown }).target)}` };
  },
};

describe('STORY-CW.5: query_codegraph backend wiring (Mode 2)', () => {
  it('empty backends → no query_codegraph; a real backend → it appears on the surface', () => {
    expect(providerToolSet().map((t) => t.name)).not.toContain('query_codegraph');
    expect(providerToolSet({ codegraph: fixtureBackend }).map((t) => t.name)).toContain('query_codegraph');
  });

  it('with a codegraph backend the tool is on the mediator surface and is ALLOWED (not default-denied)', async () => {
    const audit: any[] = [];
    const mediator = new ConfinedToolMediator({
      codegraph: fixtureBackend,
      executor: (call) => ({ ran: call.toolName }),
      onAudit: (r) => audit.push(r),
    });
    const v = await mediator.mediate({ toolCallId: '1', toolName: 'query_codegraph', input: { operation: 'search', target: 'add' } });
    expect(v.allowed).toBe(true);
    expect(audit.find((a) => a.bareTool === 'query_codegraph')?.defaultDenied).toBe(false);
  });

  it('default-deny still holds with codegraph on the surface: Bash denied, off-whitelist default-denied', async () => {
    const mediator = new ConfinedToolMediator({ codegraph: fixtureBackend, executor: () => ({}) });
    const bash = await mediator.mediate({ toolCallId: 'b', toolName: 'bash', input: { command: 'ls' } });
    expect(bash.allowed).toBe(false);
    const evil = await mediator.mediate({ toolCallId: 'e', toolName: 'mcp__evil__exfiltrate', input: {} });
    expect(evil.allowed).toBe(false);
    expect(evil.defaultDenied).toBe(true);
  });

  it('the tool-layer confinement barrier still holds (035.4 barrier unaffected)', async () => {
    const barrier = await assertToolLayerConfinementBarrier();
    expect(barrier.held).toBe(true);
    expect(barrier.invariants.every((i) => i.held)).toBe(true);
  });

  it('query_codegraph is READ-ONLY: the bridge exposes only query (no mutation path)', () => {
    const backend = codegraphBackendFromClient({ async query() { return { locations: [], impacted_files: [] }; } } as CodeGraphClient);
    expect(Object.keys(backend)).toEqual(['query']);
    const tool = providerToolSet({ codegraph: backend }).find((t) => t.name === 'query_codegraph')!;
    expect(JSON.stringify(tool.input_schema)).not.toMatch(/patch|apply|write|content/i);
  });
});

// Real engine end-to-end: the tool, behind the default-deny mediator, runs over the REAL engine.
const ENGINE = engineAvailable();
let ws = '';

describe.skipIf(!ENGINE)('STORY-CW.5: query_codegraph runs over the REAL engine, behind default-deny', () => {
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cw5-'));
    fs.writeFileSync(path.join(ws, 'math.ts'), 'export function add(a: number, b: number){ return a + b; }\n');
    buildIndex(ws);
  });
  afterAll(() => { if (ws) fs.rmSync(ws, { recursive: true, force: true }); });

  it('a query_codegraph call returns the engine summary through the mediator (read-only, allowed)', async () => {
    const backend = codegraphBackendFromClient(engineClient({ wsRoot: ws }));
    // executor routes the allowed query_codegraph call to the backend (the harness wiring).
    const mediator = new ConfinedToolMediator({
      codegraph: backend,
      executor: (call) => backend.query(String((call.input as any).operation), { target: (call.input as any).target }),
    });
    const v = await mediator.mediate({ toolCallId: 's', toolName: 'query_codegraph', input: { operation: 'search', target: 'add' } });
    expect(v.allowed).toBe(true);
    expect((v.output as { summary: string }).summary).toMatch(/add/);
  }, 120_000);
});

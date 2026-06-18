/**
 * Plan §4 — the ACI is configurable, schema-gated, and routes codegraph through one
 * uniform interface (toggleable), not raw shell. CI-safe: injected backends, no engine.
 */
import { describe, it, expect } from 'vitest';
import {
  ToolInterface, validateAgainstSchema, makeCodegraphTool, defaultHighLevelTools,
  type ToolGrants, type CodegraphBackend, type ToolDefinition,
} from './index';

const GRANTS: ToolGrants = {
  version: 1,
  roles: {
    developer: { allowed_tools: ['read_relevant_files', 'run_targeted_tests', 'query_codegraph'] },
    planning_steward: { allowed_tools: ['read_relevant_files'] }, // NOT granted codegraph
  },
};

// An injected codegraph backend that records calls — no real engine.
function stubBackend(): CodegraphBackend & { calls: Array<{ op: string; args: Record<string, unknown> }> } {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  return { calls, query(operation, args) { calls.push({ op: operation, args }); return { summary: `${operation}(${args.target}) → 3 results` }; } };
}

describe('§4 — ACI is configurable per role', () => {
  it('a role may call only its granted tools; ungranted tools are denied', async () => {
    const be = stubBackend();
    const aci = new ToolInterface(defaultHighLevelTools({ codegraph: be }), GRANTS);

    expect(aci.isAllowed('developer', 'query_codegraph').allowed).toBe(true);
    expect(aci.isAllowed('planning_steward', 'query_codegraph').allowed).toBe(false);
    expect(aci.isAllowed('planning_steward', 'query_codegraph').reason).toMatch(/not granted/);

    const denied = await aci.invoke('planning_steward', 'query_codegraph', { operation: 'callers', target: 'foo' });
    expect(denied.ok).toBe(false);
    expect(be.calls).toHaveLength(0);                 // denial never reaches the backend
  });

  it('toolsForRole reflects config grants', () => {
    const aci = new ToolInterface(defaultHighLevelTools({ codegraph: stubBackend() }), GRANTS);
    expect(aci.toolsForRole('developer').map(t => t.name).sort()).toEqual(['query_codegraph', 'read_relevant_files', 'run_targeted_tests']);
    expect(aci.toolsForRole('planning_steward').map(t => t.name)).toEqual(['read_relevant_files']);
  });
});

describe('§4 — codegraph is invoked THROUGH the interface and is toggleable', () => {
  it('a granted codegraph call routes to the injected backend', async () => {
    const be = stubBackend();
    const aci = new ToolInterface(defaultHighLevelTools({ codegraph: be }), GRANTS);
    const r = await aci.invoke('developer', 'query_codegraph', { operation: 'impact', target: 'core.mjs' });
    expect(r.ok).toBe(true);
    expect((r.output as { summary: string }).summary).toMatch(/impact\(core\.mjs\)/);
    expect(be.calls).toEqual([{ op: 'impact', args: { target: 'core.mjs' } }]);
  });

  it('disabling codegraph (scale toggle) removes it for everyone — denied + not resolved', async () => {
    const be = stubBackend();
    const aci = new ToolInterface(defaultHighLevelTools({ codegraph: be }), GRANTS);
    aci.setEnabled('query_codegraph', false);                       // small-project toggle
    expect(aci.isAllowed('developer', 'query_codegraph').allowed).toBe(false);
    expect(aci.isAllowed('developer', 'query_codegraph').reason).toMatch(/disabled/);
    expect(aci.toolsForRole('developer').map(t => t.name)).not.toContain('query_codegraph');
    const r = await aci.invoke('developer', 'query_codegraph', { operation: 'impact', target: 'core.mjs' });
    expect(r.ok).toBe(false);
    expect(be.calls).toHaveLength(0);
    expect(makeCodegraphTool(be).scale_relevant).toBe(true);
  });
});

describe('§4 — high-level tools have schemas (not raw shell) and reject malformed input', () => {
  it('every default tool declares input and output schemas; none is a raw shell', () => {
    const tools = defaultHighLevelTools({ codegraph: stubBackend() });
    for (const t of tools) {
      expect(t.input_schema.type).toBe('object');
      expect(t.output_schema.type).toBe('object');
      expect(Object.keys(t.input_schema.properties).length).toBeGreaterThan(0);
    }
    expect(tools.map(t => t.name)).not.toContain('shell');          // no raw shell tool
  });

  it('a malformed call (missing required field) is rejected before the handler runs', async () => {
    const be = stubBackend();
    const aci = new ToolInterface(defaultHighLevelTools({ codegraph: be }), GRANTS);
    const r = await aci.invoke('developer', 'query_codegraph', { operation: 'impact' }); // missing target
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/input schema violation.*target.*required/);
    expect(be.calls).toHaveLength(0);                               // handler never ran
  });

  it('validateAgainstSchema flags missing required and wrong types', () => {
    const schema = { type: 'object' as const, properties: { n: { type: 'number' as const } }, required: ['n'] };
    expect(validateAgainstSchema({ n: 5 }, schema)).toEqual([]);
    expect(validateAgainstSchema({}, schema)[0].field).toBe('n');
    expect(validateAgainstSchema({ n: 'x' }, schema)[0].message).toMatch(/expected number/);
  });
});

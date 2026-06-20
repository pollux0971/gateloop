import { describe, it, expect } from 'vitest';
import {
  ConfinedToolMediator,
  surfacePermission,
  makeValidatingPreHook,
  makeRedactPostHook,
  requireReportStopHook,
  deepRedact,
} from './confinement';
import { providerToolSet, mcpToolName } from '@gateloop/tool-interface';

describe('STORY-035.3: tool-layer confinement — MCP-only surface, Bash removed', () => {
  it('tools() exposes only high-level mcp__gateloop__* tools — NO Bash/shell', () => {
    const m = new ConfinedToolMediator();
    const names = m.tools().map((t) => t.name);
    expect(names).toContain('mcp__gateloop__apply_patch');
    expect(names).toContain('mcp__gateloop__report');
    expect(names.every((n) => n.startsWith('mcp__gateloop__'))).toBe(true);
    expect(names.some((n) => /bash|shell|exec/i.test(n))).toBe(false);
  });

  it('denies a forged Bash tool call even though it is absent from the surface', async () => {
    const m = new ConfinedToolMediator();
    const v = await m.mediate({ toolCallId: 't1', toolName: 'mcp__gateloop__bash', input: { command: 'rm -rf /' } });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/shell-like|not exposed/i);
  });

  it('denies an unlisted tool', async () => {
    const m = new ConfinedToolMediator();
    const v = await m.mediate({ toolCallId: 't1', toolName: 'mcp__gateloop__deploy_to_prod', input: {} });
    expect(v.allowed).toBe(false);
  });
});

describe('STORY-035.3: permission gateway (canUseTool) chain', () => {
  it('an injected permission can DENY a call (first deny wins)', async () => {
    const m = new ConfinedToolMediator({
      permissions: [() => ({ decision: 'deny', reason: 'out of write-set' })],
      executor: () => ({ applied: true }),
    });
    const v = await m.mediate({ toolCallId: 't1', toolName: 'mcp__gateloop__apply_patch', input: { patch: 'diff' } });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe('out of write-set');
  });

  it('surfacePermission allows in-surface, denies shell-like', () => {
    const perm = surfacePermission(['apply_patch', 'read_relevant_files']);
    expect(perm('mcp__gateloop__apply_patch', {}).decision).toBe('allow');
    expect(perm('mcp__gateloop__bash', {}).decision).toBe('deny');
    expect(perm('mcp__gateloop__unknown', {}).decision).toBe('deny');
  });
});

describe('STORY-035.3: hooks — PreToolUse deny/validate, PostToolUse redact, Stop require report', () => {
  it('PreToolUse rejects a schema-invalid input (apply_patch without patch)', async () => {
    const pre = makeValidatingPreHook(providerToolSet());
    const r = await pre({ toolName: mcpToolName('apply_patch'), input: {} });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/schema/i);
  });

  it('PostToolUse redaction removes a planted secret from the tool output', async () => {
    const post = makeRedactPostHook((s) => s.split('sk-PLANTED-123').join('[REDACTED]'));
    const r = await post({ toolName: 'mcp__gateloop__read', output: { content: 'token=sk-PLANTED-123', nested: ['sk-PLANTED-123'] } });
    expect(JSON.stringify(r.output)).not.toContain('sk-PLANTED-123');
    expect((r.output as { content: string }).content).toBe('token=[REDACTED]');
  });

  it('deepRedact walks strings in nested structures', () => {
    const out = deepRedact({ a: 'X', b: { c: ['X', 'y'] } }, (s) => s.replace('X', 'Z'));
    expect(out).toEqual({ a: 'Z', b: { c: ['Z', 'y'] } });
  });

  it('Stop hook requires a report() call before stop', async () => {
    const stop = requireReportStopHook();
    expect((await stop({ reportSeen: false })).ok).toBe(false);
    expect((await stop({ reportSeen: true })).ok).toBe(true);
  });

  it('the mediator wires it together: redacts output AND tracks the report for onStop', async () => {
    const m = new ConfinedToolMediator({
      executor: (call) => (call.toolName.endsWith('report') ? { acknowledged: true } : { content: 'leak sk-X' }),
      redact: (s) => s.split('sk-X').join('[R]'),
    });
    // before any report → onStop blocks
    expect((await m.onStop()).ok).toBe(false);

    const read = await m.mediate({ toolCallId: 'r1', toolName: 'mcp__gateloop__read_relevant_files', input: { paths: ['a.ts'] } });
    expect(read.allowed).toBe(true);
    if (read.allowed) expect(JSON.stringify(read.output)).not.toContain('sk-X'); // redacted

    await m.mediate({ toolCallId: 'r2', toolName: 'mcp__gateloop__report', input: { summary: 'done' } });
    expect((await m.onStop()).ok).toBe(true); // report seen → stop allowed
  });
});

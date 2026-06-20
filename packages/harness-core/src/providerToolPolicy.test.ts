import { describe, it, expect } from 'vitest';
import type { StoryContractView, WorkspaceOracle } from '@gateloop/permission-gateway';
import { buildProviderCanUseTool } from './providerToolPolicy.ts';

const oracle: WorkspaceOracle = {
  resolveRealPath: (p) => p,
  isDisposableWorkspace: () => true,
  escapesWorkspace: () => false,
};

const contract: StoryContractView = {
  allowedWriteSet: ['src/**'],
  forbiddenActions: [],
  networkGranted: false,
};

describe('STORY-035.3: buildProviderCanUseTool — the real permission gateway as canUseTool', () => {
  const canUse = buildProviderCanUseTool({ contract, oracle });

  it('denies a shell-like tool outright', () => {
    expect(canUse('mcp__gateloop__bash', { command: 'ls' }).decision).toBe('deny');
    expect(canUse('Bash', {}).decision).toBe('deny');
  });

  it('allows a read-only high-level tool', () => {
    expect(canUse('mcp__gateloop__read_relevant_files', { paths: ['src/a.ts'] }).decision).toBe('allow');
  });

  it('denies reading a secret/credential path (the gateway secret-path detector)', () => {
    const v = canUse('mcp__gateloop__read_relevant_files', { paths: ['.env'] });
    expect(v.decision).toBe('deny');
    expect(v.reason).toMatch(/secret|credential/i);
  });

  it('allows an in-write-set write tool, denies an out-of-write-set one (deny_unlisted)', () => {
    expect(canUse('mcp__gateloop__write_file', { path: 'src/new.ts' }).decision).toBe('allow');
    expect(canUse('mcp__gateloop__write_file', { path: 'secrets.txt' }).decision).toBe('deny');
  });

  it("an 'ask' is fail-closed to deny in autonomous confinement", () => {
    // network escalation returns 'ask' from the gateway → fail-closed deny here
    const v = buildProviderCanUseTool({
      contract,
      oracle,
      toToolRequest: () => ({ opensNetwork: true }),
    })('mcp__gateloop__read_relevant_files', { paths: ['src/a.ts'] });
    expect(v.decision).toBe('deny');
    expect(v.reason).toMatch(/^ask:/);
  });
});

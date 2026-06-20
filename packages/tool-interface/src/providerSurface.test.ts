import { describe, it, expect } from 'vitest';
import {
  providerToolSet,
  providerMcpToolNames,
  mcpToolName,
  bareToolName,
  isShellLikeTool,
  reportTool,
  PROVIDER_MCP_PREFIX,
} from './index';

describe('STORY-035.3: provider MCP tool surface (high-level only, Bash absent)', () => {
  it('the surface contains the high-level tools incl. apply_patch/git_diff/report — and NO shell', () => {
    const names = providerToolSet().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['read_relevant_files', 'run_targeted_tests', 'apply_patch', 'git_diff', 'report']));
    expect(names.some((n) => isShellLikeTool(n))).toBe(false);
  });

  it('exposes names under the mcp__gateloop__ namespace', () => {
    const names = providerMcpToolNames();
    expect(names.every((n) => n.startsWith(PROVIDER_MCP_PREFIX))).toBe(true);
    expect(mcpToolName('apply_patch')).toBe('mcp__gateloop__apply_patch');
    expect(mcpToolName('mcp__gateloop__apply_patch')).toBe('mcp__gateloop__apply_patch'); // idempotent
    expect(bareToolName('mcp__gateloop__apply_patch')).toBe('apply_patch');
  });

  it('isShellLikeTool catches the shell/bash/exec family (namespaced or bare)', () => {
    for (const n of ['bash', 'Bash', 'sh', 'shell', 'mcp__gateloop__exec', 'run_shell', 'terminal', 'cmd']) {
      expect(isShellLikeTool(n), n).toBe(true);
    }
    for (const n of ['apply_patch', 'read_relevant_files', 'git_diff', 'report']) {
      expect(isShellLikeTool(n), n).toBe(false);
    }
  });

  it('reportTool requires a summary', () => {
    expect(reportTool().input_schema.required).toContain('summary');
  });
});

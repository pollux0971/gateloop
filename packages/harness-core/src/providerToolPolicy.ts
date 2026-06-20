/**
 * Provider-mode tool permission policy (EPIC-035 / STORY-035.3).
 *
 * The harness's REAL permission gateway, expressed as a `canUseTool(toolName, input)` callback the
 * provider-driver's ConfinedToolMediator consumes. It wraps the deterministic permission-gateway
 * pipeline (`evaluateToolRequest`) so the same allow/deny policy the rest of GateLoop uses also
 * governs the in-process provider path — no second policy, no agent self-grant. Shell-like tools
 * are denied outright; in autonomous confinement an `ask` is fail-closed to `deny` (there is no
 * inline human). harness-core stays AI-SDK-free (it only imports permission-gateway + tool-interface).
 */
import {
  evaluateToolRequest,
  type StoryContractView,
  type WorkspaceOracle,
  type PermissionMode,
  type ToolRequest,
  type ToolRegistry,
} from '@gateloop/permission-gateway';
import { bareToolName, isShellLikeTool } from '@gateloop/tool-interface';

export interface ProviderPermissionVerdict {
  decision: 'allow' | 'deny';
  reason: string;
}

export interface ProviderCanUseToolOptions {
  contract: StoryContractView;
  oracle: WorkspaceOracle;
  /** Default 'deny_unlisted' — writes must be in the write-set; unlisted writes denied. */
  mode?: PermissionMode;
  registry?: ToolRegistry;
  role?: string;
  /** Map a tool call to extra ToolRequest fields (isWrite/targetPaths/command) for non-default tools. */
  toToolRequest?: (toolName: string, input: unknown) => Partial<ToolRequest>;
}

/** Tools that mutate the workspace (write path → write-set enforced; the diff is the final crux). */
const WRITE_TOOLS = new Set(['apply_patch', 'write_file', 'write', 'edit']);

export type ProviderCanUseTool = (toolName: string, input: unknown) => ProviderPermissionVerdict;

export function buildProviderCanUseTool(opts: ProviderCanUseToolOptions): ProviderCanUseTool {
  const mode = opts.mode ?? 'deny_unlisted';
  return (toolName, input) => {
    const bare = bareToolName(toolName);
    if (isShellLikeTool(toolName)) {
      return { decision: 'deny', reason: `provider policy: shell-like tool '${bare}' is denied` };
    }
    const obj = (input ?? {}) as Record<string, unknown>;
    const extra = opts.toToolRequest?.(toolName, input) ?? {};
    const targetPaths = Array.isArray(obj.paths)
      ? (obj.paths as string[])
      : typeof obj.path === 'string'
        ? [obj.path]
        : extra.targetPaths ?? [];
    const isWrite = WRITE_TOOLS.has(bare) || Boolean(extra.isWrite);
    const req: ToolRequest = {
      mode,
      tool: bare,
      cwd: '.',
      isWrite,
      targetPaths,
      ...extra,
    };
    const d = evaluateToolRequest(req, opts.contract, opts.oracle, opts.registry, opts.role);
    if (d.decision === 'allow') return { decision: 'allow', reason: d.reasons.join('; ') || 'allowed' };
    // 'ask' is fail-closed in autonomous confinement (no inline human) → deny.
    return { decision: 'deny', reason: `${d.decision}: ${d.reasons.join('; ') || 'not allowed'}` };
  };
}

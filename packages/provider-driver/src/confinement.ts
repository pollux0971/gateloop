/**
 * Tool-layer confinement (EPIC-035 / STORY-035.3) — the security model that replaces the OS cage
 * for the in-process provider path. The crux changes from "Claude *can't* (OS kernel boundary)" to
 * "Claude *doesn't see* Bash (in-process tool layer)". This module BUILDS the confinement; 035.4
 * PROVES it is effective (set ≠ effective). Three layers, all here:
 *   1. surface — only high-level MCP tools are offered; Bash/shell is absent (and denied if forged);
 *   2. permission gateway — a canUseTool chain (allow/deny per call), incl. the harness policy;
 *   3. hooks — PreToolUse (deny + validate), PostToolUse (redact secrets + trace), Stop (require report).
 */
import type { EngineTool } from './engine';
import type { ProviderToolMediator, ToolCall, ToolMediation, StopVerdict } from './providerDriver';
import {
  type ToolDefinition,
  providerToolSet,
  mcpToolName,
  bareToolName,
  isShellLikeTool,
  validateAgainstSchema,
} from '@gateloop/tool-interface';

// ── canUseTool (the permission gateway, allow/deny per call) ──────────────────────────
export interface PermissionVerdict {
  decision: 'allow' | 'deny';
  reason: string;
}
export type ToolPermission = (toolName: string, input: unknown) => PermissionVerdict | Promise<PermissionVerdict>;

/**
 * Surface permission: deny any shell-like tool and any tool NOT in the exposed MCP surface
 * (defense-in-depth — even a forged/hallucinated tool name is refused). This is the canUseTool
 * the model's calls pass through first; the harness policy (harness-core) is layered after it.
 */
export function surfacePermission(allowedBareNames: Iterable<string>): ToolPermission {
  const allowed = new Set([...allowedBareNames].map(bareToolName));
  return (toolName) => {
    const bare = bareToolName(toolName);
    if (isShellLikeTool(toolName)) return { decision: 'deny', reason: `shell-like tool '${bare}' is not exposed (Bash removed from context)` };
    if (!allowed.has(bare)) return { decision: 'deny', reason: `tool '${bare}' is not in the MCP surface` };
    return { decision: 'allow', reason: 'in MCP surface' };
  };
}

// ── Hooks ─────────────────────────────────────────────────────────────────────────────
export interface PreToolUseHookInput { toolName: string; input: unknown; }
export interface PreToolUseHookResult { decision: 'allow' | 'deny'; reason?: string; input?: unknown; }
export type PreToolUseHook = (i: PreToolUseHookInput) => PreToolUseHookResult | Promise<PreToolUseHookResult>;

export interface PostToolUseHookInput { toolName: string; output: unknown; }
export interface PostToolUseHookResult { output: unknown; }
export type PostToolUseHook = (i: PostToolUseHookInput) => PostToolUseHookResult | Promise<PostToolUseHookResult>;

export interface StopHookInput { reportSeen: boolean; }
export type StopHook = (i: StopHookInput) => StopVerdict | Promise<StopVerdict>;

/** PreToolUse: deny shell-like calls + schema-validate the input against the tool's contract. */
export function makeValidatingPreHook(surface: ToolDefinition[]): PreToolUseHook {
  const byBare = new Map(surface.map((t) => [t.name, t] as const));
  return ({ toolName, input }) => {
    if (isShellLikeTool(toolName)) return { decision: 'deny', reason: `PreToolUse: shell-like tool '${bareToolName(toolName)}' denied` };
    const def = byBare.get(bareToolName(toolName));
    if (!def) return { decision: 'deny', reason: `PreToolUse: unknown tool '${bareToolName(toolName)}'` };
    const errors = validateAgainstSchema(input ?? {}, def.input_schema);
    if (errors.length) return { decision: 'deny', reason: `PreToolUse: input schema violation: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}` };
    return { decision: 'allow' };
  };
}

/** Deep-redact every string in a value via the broker redactor (a planted secret is removed). */
export function deepRedact(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, redact));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, redact);
    return out;
  }
  return value;
}

/** PostToolUse: redact secrets from the tool output BEFORE it can enter the model/trace. */
export function makeRedactPostHook(redact: (s: string) => string): PostToolUseHook {
  return ({ output }) => ({ output: deepRedact(output, redact) });
}

/** Stop: require that the `report` tool was called before the agent may stop. */
export function requireReportStopHook(): StopHook {
  return ({ reportSeen }) => (reportSeen ? { ok: true } : { ok: false, reason: 'Stop hook: no report() call before stop' });
}

// ── The confined mediator ───────────────────────────────────────────────────────────
export interface ConfinedMediatorOptions {
  /** The exposed tool surface (defaults to providerToolSet — high-level MCP tools, no Bash). */
  surface?: ToolDefinition[];
  /** Permission chain (canUseTool); ALL must allow. Surface permission is prepended automatically. */
  permissions?: ToolPermission[];
  preHooks?: PreToolUseHook[];
  postHooks?: PostToolUseHook[];
  stopHook?: StopHook;
  /** Executes an allowed tool call (035.2 stub / the harness ToolInterface). Defaults to a no-op. */
  executor?: (call: ToolCall) => Promise<unknown> | unknown;
  /** Broker redactor, used by the default PostToolUse redaction hook. */
  redact?: (s: string) => string;
}

export class ConfinedToolMediator implements ProviderToolMediator {
  private readonly surface: ToolDefinition[];
  private readonly permissions: ToolPermission[];
  private readonly preHooks: PreToolUseHook[];
  private readonly postHooks: PostToolUseHook[];
  private readonly stopHook: StopHook;
  private readonly executor: (call: ToolCall) => Promise<unknown> | unknown;
  private reportSeen = false;

  constructor(opts: ConfinedMediatorOptions = {}) {
    this.surface = opts.surface ?? providerToolSet();
    const surfaceNames = this.surface.map((t) => t.name);
    this.permissions = [surfacePermission(surfaceNames), ...(opts.permissions ?? [])];
    this.preHooks = opts.preHooks ?? [makeValidatingPreHook(this.surface)];
    this.postHooks = opts.postHooks ?? (opts.redact ? [makeRedactPostHook(opts.redact)] : []);
    this.stopHook = opts.stopHook ?? requireReportStopHook();
    this.executor = opts.executor ?? (() => ({ ok: true }));
  }

  tools(): EngineTool[] {
    // Bash is absent by construction — the surface only contains the high-level MCP tools.
    return this.surface.map((t) => ({ name: mcpToolName(t.name), description: t.description }));
  }

  async mediate(call: ToolCall): Promise<ToolMediation> {
    let input = call.input;
    // 1. PreToolUse hooks (deny + validate + optional input mutation).
    for (const hook of this.preHooks) {
      const r = await hook({ toolName: call.toolName, input });
      if (r.decision === 'deny') return { allowed: false, reason: r.reason ?? 'PreToolUse deny' };
      if (r.input !== undefined) input = r.input;
    }
    // 2. Permission gateway chain (canUseTool) — first deny wins.
    for (const perm of this.permissions) {
      const d = await perm(call.toolName, input);
      if (d.decision === 'deny') return { allowed: false, reason: d.reason };
    }
    // 3. Execute the allowed tool.
    if (bareToolName(call.toolName) === 'report') this.reportSeen = true;
    let output = await this.executor({ ...call, input });
    // 4. PostToolUse hooks (redact secrets before the output enters model/trace).
    for (const hook of this.postHooks) {
      output = (await hook({ toolName: call.toolName, output })).output;
    }
    return { allowed: true, output };
  }

  async onStop(): Promise<StopVerdict> {
    return this.stopHook({ reportSeen: this.reportSeen });
  }
}

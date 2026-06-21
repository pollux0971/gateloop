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
  type CodegraphBackend,
  providerToolSet,
  mcpToolName,
  bareToolName,
  isShellLikeTool,
  validateAgainstSchema,
} from '@gateloop/tool-interface';
import { lookupSymbol, computeImpactSet, type CodeGraphClient } from '@gateloop/codegraph-adapter';

// ── EPIC-CW.5 (Mode 2): bridge a CodeGraphClient → the query_codegraph tool backend ──────
// The agent-facing query_codegraph tool wants `query(operation, {target}) → {summary}`; the real
// engine speaks the adapter's CodeGraphClient (`query({operation,target}) → {locations,impacted}`).
// This bridge maps between them, READ-ONLY (it only queries — no mutation of the repo or index).
// The harness builds it from a real engineClient (codegraph-client) and passes it as `codegraph`.
export function codegraphBackendFromClient(client: CodeGraphClient): CodegraphBackend {
  return {
    async query(operation, args) {
      const target = String((args as { target?: unknown }).target ?? '');
      switch (operation) {
        case 'search':
        case 'trace':
        case 'symbol_lookup': {
          const r = await lookupSymbol(target, client);
          return { summary: r.summary, locations: r.locations };
        }
        case 'impact': {
          const r = await computeImpactSet(target.split(',').map((s) => s.trim()).filter(Boolean), client);
          return { summary: r.summary, impacted_files: r.impactedFiles };
        }
        case 'callers':
        case 'callees': {
          const op = operation === 'callers' ? 'dependents' : 'dependencies';
          const raw = await client.query({ operation: op, target });
          const files = raw.impacted_files ?? [];
          return { summary: `${operation} of ${target}: ${files.length} file(s)`, impacted_files: files };
        }
        default:
          return { summary: `unsupported codegraph operation: ${operation}` };
      }
    },
  };
}

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
    // DEFAULT-DENY: anything not positively authorized is refused — malformed/empty names, unknown
    // namespaces, shell-like tools, and any tool not on the whitelist. The allow path is the ONLY
    // way through; everything else falls to deny by construction (not an enumerated denylist).
    if (typeof toolName !== 'string' || toolName.trim() === '') {
      return { decision: 'deny', reason: `default-deny: malformed tool name ${JSON.stringify(toolName)}` };
    }
    const bare = bareToolName(toolName);
    if (isShellLikeTool(toolName)) return { decision: 'deny', reason: `default-deny: shell-like tool '${bare}' is not exposed (Bash removed from context)` };
    if (!allowed.has(bare)) return { decision: 'deny', reason: `default-deny: tool '${bare}' is not in the MCP whitelist` };
    return { decision: 'allow', reason: 'in MCP whitelist' };
  };
}

/** Is a tool name positively authorized (a whitelisted, non-shell, well-formed MCP tool)? */
export function isWhitelistedTool(toolName: string, allowedBareNames: Iterable<string>): boolean {
  if (typeof toolName !== 'string' || toolName.trim() === '') return false;
  if (isShellLikeTool(toolName)) return false;
  const allowed = new Set([...allowedBareNames].map(bareToolName));
  return allowed.has(bareToolName(toolName));
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

// ── Observation: a structured audit record of every tool-call decision ───────────────
/**
 * A tamper-evident record of one tool-call decision (EPIC-035 / STORY-035.4 strengthening).
 * The observation stream the harness keeps so a 035.5 reviewer can see EXACTLY what a real model
 * tried and what was blocked — especially UNEXPECTED tools caught by default-deny.
 */
export interface ToolAuditRecord {
  toolCallId: string;
  toolName: string;
  bareTool: string;
  decision: 'allow' | 'deny';
  /** Which stage decided: pre_hook (validation), permission (gateway), or executed (allowed). */
  stage: 'pre_hook' | 'permission' | 'executed';
  reason: string;
  /** Whether the tool handler actually ran (false for every deny). */
  executorReached: boolean;
  /** Denied because not positively authorized (unknown/unexpected/malformed/shell-like). */
  defaultDenied: boolean;
  /** A short, redacted view of the input (never raw secrets). */
  inputPreview: string;
}

// ── The confined mediator ───────────────────────────────────────────────────────────
export interface ConfinedMediatorOptions {
  /** The exposed tool surface (defaults to providerToolSet — high-level MCP tools, no Bash). */
  surface?: ToolDefinition[];
  /** EPIC-CW.5 (Mode 2): a codegraph backend. When given (and no explicit surface), the READ-ONLY
   *  query_codegraph tool is added to the default surface — behind this same default-deny layer. */
  codegraph?: CodegraphBackend;
  /** Permission chain (canUseTool); ALL must allow. Surface permission is prepended automatically. */
  permissions?: ToolPermission[];
  preHooks?: PreToolUseHook[];
  postHooks?: PostToolUseHook[];
  stopHook?: StopHook;
  /** Executes an allowed tool call (035.2 stub / the harness ToolInterface). Defaults to a no-op. */
  executor?: (call: ToolCall) => Promise<unknown> | unknown;
  /** Broker redactor, used by the default PostToolUse redaction hook AND the audit input preview. */
  redact?: (s: string) => string;
  /** Observation sink — called with the audit record for every mediated call (allow or deny). */
  onAudit?: (record: ToolAuditRecord) => void;
}

export class ConfinedToolMediator implements ProviderToolMediator {
  private readonly surface: ToolDefinition[];
  private readonly surfaceBareNames: Set<string>;
  private readonly permissions: ToolPermission[];
  private readonly preHooks: PreToolUseHook[];
  private readonly postHooks: PostToolUseHook[];
  private readonly stopHook: StopHook;
  private readonly executor: (call: ToolCall) => Promise<unknown> | unknown;
  private readonly redact: (s: string) => string;
  private readonly onAudit?: (record: ToolAuditRecord) => void;
  private readonly audit: ToolAuditRecord[] = [];
  private reportSeen = false;

  constructor(opts: ConfinedMediatorOptions = {}) {
    this.surface = opts.surface ?? providerToolSet(opts.codegraph ? { codegraph: opts.codegraph } : {});
    const surfaceNames = this.surface.map((t) => t.name);
    this.surfaceBareNames = new Set(surfaceNames.map(bareToolName));
    this.permissions = [surfacePermission(surfaceNames), ...(opts.permissions ?? [])];
    this.preHooks = opts.preHooks ?? [makeValidatingPreHook(this.surface)];
    this.postHooks = opts.postHooks ?? (opts.redact ? [makeRedactPostHook(opts.redact)] : []);
    this.stopHook = opts.stopHook ?? requireReportStopHook();
    this.executor = opts.executor ?? (() => ({ ok: true }));
    this.redact = opts.redact ?? ((s) => s);
    this.onAudit = opts.onAudit;
  }

  /** The full observation log of tool-call decisions this run (allow + deny). */
  auditLog(): ToolAuditRecord[] {
    return [...this.audit];
  }

  /** Just the default-denied (unexpected/unauthorized) attempts — what a reviewer scans first. */
  defaultDenials(): ToolAuditRecord[] {
    return this.audit.filter((r) => r.decision === 'deny' && r.defaultDenied);
  }

  private record(rec: ToolAuditRecord): void {
    this.audit.push(rec);
    this.onAudit?.(rec);
  }

  private previewInput(input: unknown): string {
    let s: string;
    try { s = JSON.stringify(input ?? null); } catch { s = String(input); }
    if (s.length > 160) s = s.slice(0, 160) + '…';
    return this.redact(s);
  }

  tools(): EngineTool[] {
    // Bash is absent by construction — the surface only contains the high-level MCP tools.
    return this.surface.map((t) => ({ name: mcpToolName(t.name), description: t.description }));
  }

  async mediate(call: ToolCall): Promise<ToolMediation> {
    const bare = typeof call.toolName === 'string' ? bareToolName(call.toolName) : String(call.toolName);
    // DEFAULT-DENY classification: a deny is "default" unless the tool is positively whitelisted.
    const whitelisted = isWhitelistedTool(call.toolName, this.surfaceBareNames);
    const inputPreview = this.previewInput(call.input);
    const deny = (stage: 'pre_hook' | 'permission', reason: string): ToolMediation => {
      this.record({ toolCallId: call.toolCallId, toolName: String(call.toolName), bareTool: bare, decision: 'deny', stage, reason, executorReached: false, defaultDenied: !whitelisted, inputPreview });
      return { allowed: false, reason, defaultDenied: !whitelisted, stage };
    };

    let input = call.input;
    // 1. PreToolUse hooks (deny + validate + optional input mutation).
    for (const hook of this.preHooks) {
      const r = await hook({ toolName: call.toolName, input });
      if (r.decision === 'deny') return deny('pre_hook', r.reason ?? 'PreToolUse deny');
      if (r.input !== undefined) input = r.input;
    }
    // 2. Permission gateway chain (canUseTool) — first deny wins. The surface permission is first,
    //    so anything not positively whitelisted is refused here BEFORE any policy is consulted.
    for (const perm of this.permissions) {
      const d = await perm(call.toolName, input);
      if (d.decision === 'deny') return deny('permission', d.reason);
    }
    // 3. Execute the allowed tool.
    if (bare === 'report') this.reportSeen = true;
    let output = await this.executor({ ...call, input });
    // 4. PostToolUse hooks (redact secrets before the output enters model/trace).
    for (const hook of this.postHooks) {
      output = (await hook({ toolName: call.toolName, output })).output;
    }
    this.record({ toolCallId: call.toolCallId, toolName: String(call.toolName), bareTool: bare, decision: 'allow', stage: 'executed', reason: 'allowed: passed pre-hooks + permission chain', executorReached: true, defaultDenied: false, inputPreview });
    return { allowed: true, output };
  }

  async onStop(): Promise<StopVerdict> {
    return this.stopHook({ reportSeen: this.reportSeen });
  }
}

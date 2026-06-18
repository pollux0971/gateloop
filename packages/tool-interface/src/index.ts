/**
 * @gateloop/tool-interface — the Agent-Computer Interface (ACI), plan §4.
 *
 * Agents do not get raw shell. They get HIGH-LEVEL, schema'd tools (inspect_project,
 * read_relevant_files, propose_patch, run_targeted_tests, explain_diff, query_codegraph)
 * invoked through ONE uniform interface that:
 *   - enforces a per-role allowlist (the existing configs/tool_registry.yaml shape),
 *   - validates the tool's input against its declared schema before running it,
 *   - runs the tool's typed handler and returns typed output.
 * Tools are pluggable and configurable: which role may call which tool is config, and
 * scale-relevant tools (e.g. codegraph — worth it only on large projects) are toggleable.
 *
 * Dependency-free: tool handlers and any backend (codegraph client) are injected, so
 * the interface is provable with zero cost and no real engine.
 */

/** A minimal JSON-schema-ish shape for tool IO (enough to gate hallucinated calls). */
export interface ToolSchema {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number' | 'boolean' | 'object' | 'array'; description?: string }>;
  required?: string[];
}

export interface ToolDefinition<I = Record<string, unknown>, O = unknown> {
  name: string;
  description: string;
  /** Declared input contract — NOT a raw command string. */
  input_schema: ToolSchema;
  /** Declared output contract. */
  output_schema: ToolSchema;
  /** Scale-relevant tools cost more than they return on small projects → toggleable. */
  scale_relevant?: boolean;
  /** Config toggle; a disabled tool is never resolved or invoked. Default true. */
  enabled?: boolean;
  handler(input: I): Promise<O> | O;
}

/** Mirrors configs/tool_registry.yaml — per-role allowlists (config-driven grants). */
export interface ToolGrants {
  version: number;
  roles: Record<string, { allowed_tools: string[]; description?: string }>;
}

export interface SchemaError { field: string; message: string }

/** Validate an input object against a tool schema: required present + primitive types. */
export function validateAgainstSchema(input: unknown, schema: ToolSchema): SchemaError[] {
  const errors: SchemaError[] = [];
  if (typeof input !== 'object' || input === null) {
    return [{ field: '(root)', message: 'input must be an object' }];
  }
  const obj = input as Record<string, unknown>;
  for (const req of schema.required ?? []) {
    if (obj[req] === undefined || obj[req] === null) errors.push({ field: req, message: 'required field missing' });
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (actual !== spec.type) errors.push({ field: key, message: `expected ${spec.type}, got ${actual}` });
  }
  return errors;
}

export interface InvokeDecision { allowed: boolean; reason: string }
export interface InvokeResult<O = unknown> { ok: boolean; output?: O; error?: string }

/**
 * The unified ACI. Holds tool definitions + the per-role grant config. Every call is
 * grant-checked, enabled-checked, and schema-validated before the handler runs.
 */
export class ToolInterface {
  private tools = new Map<string, ToolDefinition>();
  constructor(defs: ToolDefinition[], private grants: ToolGrants) {
    for (const d of defs) this.tools.set(d.name, { enabled: true, ...d });
  }

  has(name: string): boolean { return this.tools.has(name); }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name); }

  /** Toggle a tool on/off (the scale-relevant config switch). */
  setEnabled(name: string, enabled: boolean): void {
    const t = this.tools.get(name);
    if (t) t.enabled = enabled;
  }

  /** Is a role permitted to call a tool right now (granted AND enabled AND registered)? */
  isAllowed(role: string, name: string): InvokeDecision {
    const tool = this.tools.get(name);
    if (!tool) return { allowed: false, reason: `unknown tool: ${name}` };
    if (tool.enabled === false) return { allowed: false, reason: `tool disabled: ${name}` };
    const entry = this.grants.roles[role];
    if (!entry) return { allowed: false, reason: `role not in tool registry: ${role}` };
    if (!entry.allowed_tools.includes(name)) return { allowed: false, reason: `tool not granted to ${role}: ${name}` };
    return { allowed: true, reason: 'granted, enabled, registered' };
  }

  /** The high-level tools a role may actually use (granted AND enabled). */
  toolsForRole(role: string): ToolDefinition[] {
    const entry = this.grants.roles[role];
    if (!entry) return [];
    return [...this.tools.values()].filter(t => t.enabled !== false && entry.allowed_tools.includes(t.name));
  }

  /** Invoke a tool: grant → enabled → schema-validate → run handler. Denials/malformed
   *  inputs never reach the handler (a hallucinated call is rejected, not executed). */
  async invoke<O = unknown>(role: string, name: string, input: Record<string, unknown>): Promise<InvokeResult<O>> {
    const decision = this.isAllowed(role, name);
    if (!decision.allowed) return { ok: false, error: decision.reason };
    const tool = this.tools.get(name)!;
    const schemaErrors = validateAgainstSchema(input, tool.input_schema);
    if (schemaErrors.length) {
      return { ok: false, error: `input schema violation: ${schemaErrors.map(e => `${e.field}: ${e.message}`).join('; ')}` };
    }
    const output = (await tool.handler(input)) as O;
    return { ok: true, output };
  }
}

// ── Example tool #1: codegraph, routed through the ACI (toggleable, scale-relevant) ──
// codegraph is accessed via this tool, NOT hardcoded into agents. Its backend is an
// injected client so the interface stays engine-free and CI-safe. On a small project
// the operator can disable it (scale_relevant) with one config toggle.

/** Minimal structural client — satisfied by @gateloop/codegraph-adapter's CodeGraphClient. */
export interface CodegraphBackend {
  query(operation: string, args: Record<string, unknown>): Promise<{ summary: string; [k: string]: unknown }> | { summary: string; [k: string]: unknown };
}

export function makeCodegraphTool(backend: CodegraphBackend, opts: { enabled?: boolean } = {}): ToolDefinition {
  return {
    name: 'query_codegraph',
    description: 'Structural code intelligence (callers/callees/impact/search/trace) from the indexed graph. Scale-relevant: enable on large projects, disable on small ones.',
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'callers | callees | impact | search | trace' },
        target: { type: 'string', description: 'symbol or file to query' },
      },
      required: ['operation', 'target'],
    },
    output_schema: { type: 'object', properties: { summary: { type: 'string' } } },
    scale_relevant: true,
    enabled: opts.enabled ?? true,
    async handler(input) {
      return backend.query(String(input.operation), { target: input.target });
    },
  };
}

/** A small high-level toolset (schema'd, never raw shell) — the ACI surface agents get. */
export function defaultHighLevelTools(backends: { codegraph?: CodegraphBackend } = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'read_relevant_files',
      description: 'Read the files relevant to the current task (paths resolved by the harness, not free-form).',
      input_schema: { type: 'object', properties: { paths: { type: 'array', description: 'workspace-relative paths' } }, required: ['paths'] },
      output_schema: { type: 'object', properties: { files: { type: 'object' } } },
      handler: () => ({ files: {} }),
    },
    {
      name: 'run_targeted_tests',
      description: 'Run a targeted set of tests (test files), returning pass/fail — never an arbitrary shell command.',
      input_schema: { type: 'object', properties: { test_files: { type: 'array' } }, required: ['test_files'] },
      output_schema: { type: 'object', properties: { passed: { type: 'boolean' }, failing: { type: 'array' } } },
      handler: () => ({ passed: true, failing: [] }),
    },
  ];
  if (backends.codegraph) tools.push(makeCodegraphTool(backends.codegraph));
  return tools;
}

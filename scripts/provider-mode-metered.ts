/**
 * Provider-mode E2E (METERED) — a REAL model works a trivial story IN-PROCESS through the tool
 * layer on a STANDARD, metered OpenAI API key (EPIC-035 product-default path; the (b) run).
 *
 * This is the metered SIBLING of scripts/provider-mode-codex.ts (035.5, which ran the same
 * pipeline on the Codex SUBSCRIPTION). The ONLY controlled variable here is the engine/auth/
 * endpoint:
 *   035.5 (subscription): createOpenAI({ apiKey: 'dummy', fetch: createCodexFetch }) → chatgpt.com
 *   (b)    (metered):     createOpenAI({ apiKey: <broker OPENAI_API_KEY> })          → api.openai.com
 * Everything else — the confined tool layer (ConfinedToolMediator: default-deny surface, real
 * permission gateway, Pre/Post hooks, audit log), the disposable sandbox, the authoritative
 * git-diff, and the inherited exit gate — is identical. So a green run proves the ADR claim
 * "same pipeline, only the credential/endpoint differ; swap fetch/engine" is literally true.
 *
 * This file is DELIBERATELY self-contained and imports NO @gateloop/subscription-auth — the
 * metered core is detachable from the subscription plugin (035.6), and this script proves it by
 * running the whole path with zero subscription code in scope.
 *
 * The metered key is resolved through the Secret Broker AT THE CALL BOUNDARY via
 * subprocessEnvSource: a CHILD process sources the operator's .env and returns ONLY the value,
 * so neither this script nor the agent ever reads .env. The plaintext lives only inside the
 * broker.resolve() / createMeteredEngine() closure and is never returned to the core, logged, or
 * printed. real_api_calls is opened and closed (read-back verified) by runGated.
 *
 * Three entry points:
 *   runFixtureStory()  — scripted model (no network, no spend) — validates the whole pipeline.
 *   runEngineSmoke()   — gated, tiny text call through createMeteredEngine — proves the literal
 *                        metered ENGINE wrapper reaches api.openai.com with the broker key.
 *   runMeteredStory()  — gated REAL model call working the trivial story through the tool layer.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, tool, jsonSchema, stepCountIs } from 'ai';
import {
  ConfinedToolMediator,
  assertToolLayerConfinementBarrier,
  mapEnginePartToAgentEvent,
  normalizeAiSdkPart,
  pickMeteredBackend,
  resolveMeteredKey,
  createMeteredEngine,
  type ToolAuditRecord,
} from '@gateloop/provider-driver';
import { buildProviderCanUseTool, requireConfinementBeforeSpend } from '@gateloop/harness-core';
import { runGated, BudgetLedger } from '@gateloop/gate-control';
import {
  runExitGate,
  buildDelegationResult,
  type ExitGateContract,
  type AgentEvent,
} from '@gateloop/agent-delegate';
import { type ToolDefinition, bareToolName, reportTool } from '@gateloop/tool-interface';
import { SecretBroker, subprocessEnvSource } from '@gateloop/secret-broker';

const here = path.dirname(fileURLToPath(import.meta.url));
export const POLICY_PATH = path.resolve(here, '../configs/policy.yaml');
/** The operator's .env (workspace root). The broker's CHILD sources it — this script never reads it. */
export const ENV_FILE = process.env.GATELOOP_ENV_FILE ?? path.resolve(here, '../../.env');
/** Metered backend = standard OpenAI key (OPENAI_API_KEY) → api.openai.com. */
export const METERED_BACKEND = 'openai';

// ── The trivial story (identical to 035.5 — single controlled variable is the engine) ────────
export const STORY_WRITE_SET = ['slugify.mjs'];
export const STORY_PROMPT = [
  'You are working in a sandboxed project directory.',
  'Task: create exactly one file named slugify.mjs that exports a function:',
  '  export function slugify(input) { /* ... */ }',
  'slugify lowercases the input, trims whitespace, replaces every run of non-alphanumeric',
  'characters with a single hyphen, and strips leading/trailing hyphens. Pure ESM, no deps.',
  'Use the write_file tool to create ONLY slugify.mjs. Then call report with a short summary.',
  'Do not create or modify any other file. You have no shell; use only the provided tools.',
].join('\n');

export const STORY_SYSTEM =
  'You are a careful coding agent confined to a sandbox. Use ONLY the provided tools ' +
  '(write_file, read_relevant_files, report). You have no shell. Create only the requested ' +
  'file, then call report.';

// ── The exposed MCP tool surface (high-level only; NO Bash/shell) ─────────────────────────────
export function storyToolSurface(): ToolDefinition[] {
  return [
    {
      name: 'write_file',
      description: 'Create or overwrite a single file in the workspace (confined to the write-set by the harness).',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative path' }, content: { type: 'string', description: 'full file contents' } }, required: ['path', 'content'] },
      output_schema: { type: 'object', properties: { written: { type: 'string' } } },
      handler: () => ({}),
    },
    {
      name: 'read_relevant_files',
      description: 'Read files from the workspace (read-only).',
      input_schema: { type: 'object', properties: { paths: { type: 'array', description: 'workspace-relative paths' } }, required: ['paths'] },
      output_schema: { type: 'object', properties: { files: { type: 'object' } } },
      handler: () => ({}),
    },
    reportTool(),
  ];
}

// ── Disposable sandbox (the ONLY writable surface) ────────────────────────────────────────────
export interface Sandbox {
  root: string;
  cleanup(): void;
}

export function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-metered-story-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# text toolkit\n\nA tiny pure-ESM utility kit.\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'sandbox@gateloop.local']);
  git(['config', 'user.name', 'sandbox']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'pre-task tree']);
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Resolve a workspace-relative path, refusing any escape outside the sandbox root. */
function safeResolve(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const rootResolved = fs.realpathSync(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error(`path escapes sandbox: ${rel}`);
  }
  return abs;
}

/** The git diff of the sandbox vs the pre-task tree (authoritative changed-file source). */
export function collectSandboxDiff(root: string): string {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  return execFileSync('git', ['diff', '--cached'], { cwd: root, encoding: 'utf8' });
}

// ── The real executor (does the actual work for an ALLOWED tool call) ─────────────────────────
export function makeExecutor(root: string): (call: { toolName: string; input: unknown }) => unknown {
  return ({ toolName, input }) => {
    const bare = bareToolName(toolName);
    const obj = (input ?? {}) as Record<string, unknown>;
    if (bare === 'write_file') {
      const rel = String(obj.path ?? '');
      const abs = safeResolve(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(obj.content ?? ''));
      return { written: rel };
    }
    if (bare === 'read_relevant_files') {
      const files: Record<string, string> = {};
      for (const p of (Array.isArray(obj.paths) ? obj.paths : []) as string[]) {
        const abs = safeResolve(root, String(p));
        files[p] = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      }
      return { files };
    }
    if (bare === 'report') return { acknowledged: true };
    return { error: `no handler for tool: ${bare}` };
  };
}

// ── The confined mediator (default-deny + permission + hooks + audit) ─────────────────────────
export interface ConfinedRun {
  mediator: ConfinedToolMediator;
  audit: ToolAuditRecord[];
}

export function buildConfinedRun(root: string, redact: (s: string) => string = (s) => s): ConfinedRun {
  const surface = storyToolSurface();
  const audit: ToolAuditRecord[] = [];
  const oracle = {
    resolveRealPath: (p: string) => path.resolve(root, p),
    isDisposableWorkspace: () => true,
    escapesWorkspace: (p: string) => { const r = fs.realpathSync(root); return p !== r && !p.startsWith(r + path.sep); },
  };
  const mediator = new ConfinedToolMediator({
    surface,
    permissions: [buildProviderCanUseTool({ contract: { allowedWriteSet: STORY_WRITE_SET, forbiddenActions: [], networkGranted: false }, oracle })],
    executor: makeExecutor(root),
    redact,
    onAudit: (r) => audit.push(r),
  });
  return { mediator, audit };
}

// ── Exit gate over the authoritative diff ─────────────────────────────────────────────────────
export function gateDiff(diff: string, events: AgentEvent[]) {
  const contract: ExitGateContract = {
    story_id: 'STORY-035-provider-metered-openai',
    allowed_write_set: STORY_WRITE_SET,
    acceptance_criteria: { behaviors_must_pass: ['slugify_lowercases_trims_collapses_strips'] },
  };
  return runExitGate(buildDelegationResult({ cli: 'codex', diff, events }), contract, {});
}

export interface StoryRunResult {
  ran: boolean;
  events: AgentEvent[];
  audit: ToolAuditRecord[];
  diff: string;
  changed_files: string[];
  accepted: boolean;
  rejected_whole: boolean;
  out_of_write_set: string[];
  default_denials: ToolAuditRecord[];
  usage?: unknown;
  gateClosedVerified?: boolean;
  reason?: string;
}

// ── FIXTURE runner (scripted model; no network, no spend) ─────────────────────────────────────
export async function runFixtureStory(): Promise<StoryRunResult> {
  const sandbox = makeSandbox();
  try {
    const { mediator, audit } = buildConfinedRun(sandbox.root);
    const events: AgentEvent[] = [];
    const slug = 'export function slugify(input){return String(input).toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");}\n';
    const scriptedCalls = [
      { toolName: 'write_file', input: { path: 'slugify.mjs', content: slug } },
      { toolName: 'bash', input: { command: 'rm -rf /' } },              // UNEXPECTED → must default-deny
      { toolName: 'report', input: { summary: 'created slugify.mjs' } },
    ];
    let n = 0;
    for (const c of scriptedCalls) {
      events.push(mapEnginePartToAgentEvent('codex', { type: 'tool-call', toolCallId: `f${++n}`, toolName: c.toolName, input: c.input })!);
      const v = await mediator.mediate({ toolCallId: `f${n}`, toolName: c.toolName, input: c.input });
      if (v.allowed) {
        events.push(mapEnginePartToAgentEvent('codex', { type: 'tool-result', toolCallId: `f${n}`, toolName: c.toolName, output: v.output })!);
      } else {
        events.push({ cli: 'codex', kind: 'tool_result', tool: c.toolName, summary: `tool_default_denied:${c.toolName} ${v.reason}`, raw: { default_denied: Boolean(v.defaultDenied), reason: v.reason, toolName: c.toolName } });
      }
    }
    const diff = collectSandboxDiff(sandbox.root);
    const verdict = await gateDiff(diff, events);
    return {
      ran: true, events, audit, diff,
      changed_files: verdict.changed_files, accepted: verdict.accepted,
      rejected_whole: verdict.rejected_whole, out_of_write_set: verdict.out_of_write_set,
      default_denials: audit.filter((r) => r.decision === 'deny' && r.defaultDenied),
    };
  } finally {
    sandbox.cleanup();
  }
}

// ── AI SDK tools — each execute() goes through the mediator (permission + hooks + audit) ───────
function aiSdkTools(mediator: ConfinedToolMediator) {
  const tools: Record<string, ReturnType<typeof tool>> = {};
  let n = 0;
  for (const t of storyToolSurface()) {
    tools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.input_schema as Record<string, unknown>),
      execute: async (args: unknown) => {
        const v = await mediator.mediate({ toolCallId: `tc_${++n}`, toolName: t.name, input: args });
        if (!v.allowed) return { error: `denied by harness: ${v.reason}` };
        return v.output;
      },
    });
  }
  return tools;
}

// ── The metered broker (subprocessEnvSource: a child sources .env; we never read it) ──────────
export function makeMeteredBroker(envFile: string = ENV_FILE): SecretBroker {
  return new SecretBroker(subprocessEnvSource({ envFile }));
}

/** Existence check for the metered key — returns a BOOLEAN + length only, never the value. */
export async function meteredKeyPresent(envFile: string = ENV_FILE): Promise<{ present: boolean; length: number }> {
  const broker = makeMeteredBroker(envFile);
  const key = await resolveMeteredKey(broker, pickMeteredBackend(METERED_BACKEND));
  return { present: key.length > 0, length: key.length };
}

// ── ENGINE SMOKE (gated): prove the LITERAL createMeteredEngine reaches api.openai.com ─────────
export interface EngineSmokeResult {
  ran: boolean;
  text: string;
  usage?: unknown;
  gateClosedVerified?: boolean;
  reason?: string;
}

/**
 * Build a metered engine via the product's own createMeteredEngine (broker resolves the key
 * inside its closure; modelFactory builds a STANDARD createOpenAI model → api.openai.com), then
 * consume a one-token reply. This validates the named "ProviderDriver + createMeteredEngine →
 * api.openai.com" wire path directly, end-to-end, with no custom fetch.
 */
export async function runEngineSmoke(opts: { modelId?: string; envFile?: string; budgetUsd?: number } = {}): Promise<EngineSmokeResult> {
  const spec = pickMeteredBackend(METERED_BACKEND);
  const modelId = opts.modelId ?? process.env.METERED_MODEL ?? spec.defaultModel;
  const broker = makeMeteredBroker(opts.envFile);
  const budget = new BudgetLedger(opts.budgetUsd ?? 1);

  const engine = await createMeteredEngine({
    spec,
    model: modelId,
    broker,
    streamText,
    // plaintext key exists ONLY inside this factory closure; the standard provider → api.openai.com
    modelFactory: (apiKey, m) => createOpenAI({ apiKey }).responses(m),
  });

  let text = '';
  let usage: unknown;
  const gated = await runGated(async () => {
    for await (const part of engine.stream({ prompt: 'Reply with exactly the single word: ok', system: 'Reply with exactly: ok' })) {
      if (part.type === 'text-delta') text += part.text ?? '';
      if (part.type === 'finish') usage = part.usage;
    }
    return true;
  }, { policyPath: POLICY_PATH, budget, env: { CI: process.env.CI } });

  return { ran: gated.ran, text: text.slice(0, 40), usage, gateClosedVerified: gated.gateClosedVerified, reason: gated.reason };
}

// ── LIVE story runner (gated REAL metered model through the tool layer) ────────────────────────
export interface MeteredStoryOptions {
  modelId?: string;
  envFile?: string;
  budgetUsd?: number;
  redact?: (s: string) => string;
}

export async function runMeteredStory(opts: MeteredStoryOptions = {}): Promise<StoryRunResult> {
  const spec = pickMeteredBackend(METERED_BACKEND);
  const modelId = opts.modelId ?? process.env.METERED_MODEL ?? spec.defaultModel;
  const redact = opts.redact ?? ((s) => s);

  // PRECONDITION: the tool-layer confinement barrier must be proven held before any spend (035.4).
  const barrier = await assertToolLayerConfinementBarrier();
  requireConfinementBeforeSpend(barrier); // throws fail-closed if not all-held

  const broker = makeMeteredBroker(opts.envFile);
  const sandbox = makeSandbox();
  try {
    const { mediator, audit } = buildConfinedRun(sandbox.root, redact);
    const events: AgentEvent[] = [];
    const budget = new BudgetLedger(opts.budgetUsd ?? Number(process.env.EVAL_BUDGET_USD ?? 5));

    let usage: unknown;
    const gated = await runGated(async () => {
      // Plaintext key produced at the call boundary, used only to build the standard model, never logged.
      const apiKey = await resolveMeteredKey(broker, spec);
      if (!apiKey) throw new Error(`no metered key for '${METERED_BACKEND}' (broker provider '${spec.keyProvider}' / ${ENV_FILE})`);
      const openai = createOpenAI({ apiKey }); // STANDARD api.openai.com — the single variable vs 035.5
      const model = openai.responses(modelId);
      const tools = aiSdkTools(mediator);

      const result = streamText({
        model,
        // Mirror 035.5 exactly: system goes through the OpenAI responses `instructions` field; no store.
        providerOptions: { openai: { instructions: STORY_SYSTEM, store: false } },
        prompt: STORY_PROMPT,
        tools,
        stopWhen: stepCountIs(8),
      });
      for await (const part of result.fullStream) {
        const np = normalizeAiSdkPart(part as unknown as { type: string });
        if (np) { const ev = mapEnginePartToAgentEvent('codex', np, redact); if (ev) events.push(ev); }
      }
      usage = await result.totalUsage;
      return true;
    }, { policyPath: POLICY_PATH, budget, env: { CI: process.env.CI } });

    const diff = collectSandboxDiff(sandbox.root);
    const verdict = await gateDiff(diff, events);
    return {
      ran: gated.ran, events, audit, diff,
      changed_files: verdict.changed_files, accepted: verdict.accepted,
      rejected_whole: verdict.rejected_whole, out_of_write_set: verdict.out_of_write_set,
      default_denials: audit.filter((r) => r.decision === 'deny' && r.defaultDenied),
      usage, gateClosedVerified: gated.gateClosedVerified, reason: gated.reason,
    };
  } finally {
    sandbox.cleanup();
  }
}

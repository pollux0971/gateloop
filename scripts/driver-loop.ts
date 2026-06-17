/**
 * Driver loop — the real autonomous development loop on the scripted provider.
 * STORY-029.7: 008.5 made real now that the cognition functions exist.
 *
 * Wires the genuine cognition path end to end:
 *   select → composeDeveloperTaskPacket (029.2) → producePatchProposal (029.3)
 *   → preflight → spec-conformance gate → workspace apply → validate
 *   → (FAIL) composeDebuggerTaskPacket (029.4) → produceRepairProposal (029.5)
 *   → re-validate → summarizeProgress (029.6) → CHECKPOINT.
 *
 * Scenario: add(a,b) throws. The scripted developer proposes a WRONG fix (a-b);
 * validation FAILS; the scripted debugger proposes the CORRECT repair (a+b);
 * re-validation PASSES → machine-readable checkpoint. On a terminal failure the
 * loop rolls the workspace back (029.7 rollbackWorkspace).
 *
 * No real LLM. No external API. No secrets. Fully deterministic and CI-safe.
 * Run:  node --experimental-strip-types scripts/driver-loop.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WorkspaceRegistry, createDisposableWorkspace,
  seedFile, commitAll, makeOracle, cleanupWorkspace,
} from '@gateloop/workspace-manager';
import { applyProposal, runValidation } from '@gateloop/tool-executor';
import { specConformanceGate } from '@gateloop/validator-suite';
import { runPreflight } from '@gateloop/preflight-runner';
import {
  selectNextStory, writeCheckpoint, rollbackWorkspace, canTransition,
  type StoryRecord,
} from '@gateloop/harness-core';
import {
  composeDeveloperTaskPacket, composeDebuggerTaskPacket, summarizeProgress,
} from '@gateloop/supervisor-runtime';
import { producePatchProposal } from '@gateloop/developer-runtime';
import { produceRepairProposal } from '@gateloop/debugger-runtime';
import {
  ProviderRegistry, createScriptedProvider,
  bootstrapLiveProviders, BudgetGuard, guardedCall, validateStructuredOutput,
  resolveProviderIdsFromConfig, parseModelRef,
  type RoutingConfig, type AgentStructuredOutput,
  type TypedSecretHandle, type SecretResolver, type RealProviderHttpClient,
  type BudgetConfig, type ModelGatewayRequest, type ProviderRegistrationRecord,
} from '@gateloop/model-gateway';
import type { AskModelDeps } from '@gateloop/agent-core';

// ── Scenario constants ───────────────────────────────────────────────────────

const STORY_ID = 'STORY-DRIVER-LOOP';
const FIXED_TS = '2026-06-14T00:00:00.000Z';

const BROKEN_MATH =
  `export function add(a: number, b: number): number { throw new Error('not implemented'); }\n`;
const CHECK_SCRIPT =
  `import { add } from '../src/math.ts';\n` +
  `if (add(2, 3) !== 5) { console.error('FAIL add(2,3)!==5'); process.exit(1); }\n` +
  `console.log('ok add(2,3)=5');\n`;

// Developer proposes a WRONG fix (a - b) → validation fails → triggers debug.
const WRONG_PATCH = [
  'diff --git a/src/math.ts b/src/math.ts',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1 +1 @@',
  `-export function add(a: number, b: number): number { throw new Error('not implemented'); }`,
  '+export function add(a: number, b: number): number { return a - b; }',
  '',
].join('\n');
// Debugger proposes the CORRECT repair (a + b).
const REPAIR_PATCH = [
  'diff --git a/src/math.ts b/src/math.ts',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1 +1 @@',
  '-export function add(a: number, b: number): number { return a - b; }',
  '+export function add(a: number, b: number): number { return a + b; }',
  '',
].join('\n');

// ── Result types ─────────────────────────────────────────────────────────────

export interface DriverCheckpoint {
  story_id: string;
  developer_provider_kind: string;
  debugger_provider_kind: string;
  preflight_decision: string;
  first_validation: 'passed' | 'failed';
  repaired: boolean;
  final_validation: 'passed' | 'failed';
  progress_summary: string;
  final_checkpoint_marker: string;
}

export interface DriverLoopResult {
  reached_checkpoint: boolean;
  checkpoint: DriverCheckpoint | null;
  rolled_back: boolean;
  used_real_provider: boolean;
  output: string;
}

// ── Scripted cognition deps (no LLM) ─────────────────────────────────────────

function scriptedDeps(): AskModelDeps {
  const developerOutput = {
    kind: 'patch_proposal',
    proposal_id: 'PP-DRIVER-001',
    story_id: STORY_ID,
    summary: 'Implement add as subtraction (intentionally wrong — exercise the debug path)',
    change_type: 'new_impl',
    changed_files: ['src/math.ts'],
    edits: [{ path: 'src/math.ts', operation: 'modify' }],
    rationale_summary: 'First attempt at add(a,b).',
    rollback_notes: 'git checkout -- src/math.ts',
  } as AgentStructuredOutput;

  const repairOutput = {
    kind: 'repair_proposal',
    proposal_id: 'RP-DRIVER-001',
    story_id: STORY_ID,
    summary: 'Rebind add to a + b',
    change_type: 'REBIND',
    changed_files: ['src/math.ts'],
    edits: [{ path: 'src/math.ts', operation: 'modify' }],
    rationale_summary: 'add must sum, not subtract.',
    rollback_notes: 'git checkout -- src/math.ts',
  } as AgentStructuredOutput;

  const registry = new ProviderRegistry();
  registry.register(createScriptedProvider('scripted-developer', [
    { case_id: 'dev', match: { target_agent: 'developer' }, output: developerOutput },
  ]));
  registry.register(createScriptedProvider('scripted-debugger', [
    { case_id: 'dbg', match: { target_agent: 'debugger' }, output: repairOutput },
  ]));
  const routing: RoutingConfig = {
    agents: {
      developer: { primary: 'scripted-developer' },
      debugger: { primary: 'scripted-debugger' },
    },
  };
  return { registry, routing };
}

// ── Main orchestration ───────────────────────────────────────────────────────

export async function runDriverLoop(opts: { print?: boolean } = {}): Promise<DriverLoopResult> {
  const logs: string[] = [];
  const line = (s: string) => { logs.push(s); if (opts.print ?? true) console.log(s); };
  const fail = (rolledBack: boolean): DriverLoopResult =>
    ({ reached_checkpoint: false, checkpoint: null, rolled_back: rolledBack, used_real_provider: false, output: logs.join('\n') });

  const registry = new WorkspaceRegistry();
  const deps = scriptedDeps();

  // The story contract (the enforceable source of truth).
  const contract = {
    story_id: STORY_ID,
    story_contract_ref: `story_contract:${STORY_ID}`,
    objective: 'Implement add(a, b) so that add(2, 3) === 5',
    allowed_write_set: ['src/**'],
    forbidden_actions: ['no sudo', 'no real_api', 'no writes outside src/**'],
    acceptance_criteria: ['add_2_3_equals_5'],
    validation_commands: ['node --experimental-strip-types test/check.ts'],
    rollback_notes: 'git checkout -- src/math.ts',
  };
  const applyContract = { allowedWriteSet: contract.allowed_write_set, forbiddenActions: ['sudo', 'real_api'] };
  const validationCommands = contract.validation_commands;

  // ── Step 0: SELECT the next story from the backlog ──────────────────────────
  const stories: StoryRecord[] = [{
    story_id: STORY_ID, epic_id: 'EPIC-DRIVER', depends_on: [], parallelism_class: 'sequential',
    status: 'todo', attempts: 0, attempt_budget: 3, branch: null,
    last_action: null, last_result: null, last_validation: null, blocked_reason: null,
  }];
  const selected = selectNextStory(stories);
  line(`[select] next story: ${selected}`);
  if (selected !== STORY_ID) return fail(false);

  const ws = createDisposableWorkspace(registry, { story_id: STORY_ID });
  const oracle = makeOracle(registry);
  const story = stories[0];
  story.branch = ws.workspace_id;
  line(`[workspace] disposable=${ws.disposable} @ ${ws.root}`);

  try {
    // ── Seed the failing baseline ─────────────────────────────────────────────
    seedFile(ws, 'src/math.ts', BROKEN_MATH);
    seedFile(ws, 'test/check.ts', CHECK_SCRIPT);
    commitAll(ws, `seed ${STORY_ID}`);

    // ── Step 1: Supervisor composes the developer task packet (029.2) ─────────
    const devPacket = composeDeveloperTaskPacket({
      contract,
      contextRefs: ['ws/src/math.ts'],
      failureWarnings: [],
    });
    line(`[supervisor] developer packet: ${devPacket.packet_id} (write-set ${devPacket.allowed_write_set.join(',')})`);

    // ── Step 2: Developer produces a patch proposal via askModel (029.3) ──────
    const dev = await producePatchProposal(devPacket, deps, { proposedAt: FIXED_TS, patchBranch: ws.workspace_id });
    line(`[developer] producePatchProposal: ${dev.ok ? 'OK' : 'FAIL ' + dev.errors.join('; ')}`);
    if (!dev.ok || !dev.proposal) return fail(false);
    const devProposalKind = 'scripted';

    // proposal object for the gate + the materializing diff (scenario-controlled).
    const proposalForGate = {
      ...dev.proposal,
      patch_text: WRONG_PATCH,
    } as Record<string, unknown>;

    // ── Step 3: Preflight advisory self-check ─────────────────────────────────
    const preflight = await runPreflight({
      ...proposalForGate,
      story_id: STORY_ID,
      validation_results: { 'node test/check.ts': false },
      self_correction_attempts: 0,
      same_signature_count: 0,
    }, ws);
    line(`[preflight] advisory verdict=${preflight.verdict} (not the story verdict)`);

    // ── Step 4: Spec-conformance gate (HARD) ──────────────────────────────────
    const gate = specConformanceGate({
      proposal: proposalForGate,
      contract: { allowed_write_set: contract.allowed_write_set, acceptance_criteria: { behaviors_must_pass: contract.acceptance_criteria } },
    });
    line(`[spec-gate] ${gate.ok ? 'PASS' : 'FAIL ' + JSON.stringify(gate.errors)}`);
    if (!gate.ok) return fail(false);

    // ── Step 5: Workspace apply via permission gateway ────────────────────────
    const diffPath = path.join(ws.root, '_dev.diff');
    fs.writeFileSync(diffPath, WRONG_PATCH);
    const applied = applyProposal({ ws, diffPath, changedFiles: dev.proposal.changed_files, contract: applyContract, oracle });
    line(`[apply] ${applied.applied ? 'APPLIED' : 'BLOCKED'} decision=${applied.decision.decision}`);
    if (!applied.applied) return fail(false);
    line(`  transition WORKSPACE_APPLY→VALIDATION = ${canTransition('WORKSPACE_APPLY', 'VALIDATION')}`);

    // ── Step 6: First validation — expected FAIL ──────────────────────────────
    const verdict1 = runValidation(ws, validationCommands);
    line(`[validate-1] ${verdict1.passed ? 'PASS' : 'FAIL'} (expected FAIL — a-b)`);

    let repaired = false;
    let finalPassed = verdict1.passed;

    if (!verdict1.passed) {
      // ── Step 7: Supervisor composes the debugger task packet (029.4) ────────
      const firstFailed = verdict1.results.find(r => !r.ok);
      const dbgPacket = composeDebuggerTaskPacket({
        contract,
        failure: {
          failed_command: firstFailed?.command,
          failure_signature: `test|add|quota`,
          validation_report_ref: `trace:${STORY_ID}/run1`,
          failed_acceptance: contract.acceptance_criteria,
        },
        diff: { changed_files: dev.proposal.changed_files, current_patch_ref: dev.proposal.proposal_id },
        gene: { matching_signal: 'test|add', avoid: 'Do not subtract; add must sum a and b', consolidated_count: 1 },
      });
      line(`[supervisor] debugger packet: ${dbgPacket.packet_id} (repair scope ${dbgPacket.allowed_repair_scope.join(',')})`);
      line(`  transition VALIDATION→DEBUG_LOOP = ${canTransition('VALIDATION', 'DEBUG_LOOP')}`);

      // ── Step 8: Debugger produces a repair via askModel (029.5) ─────────────
      const repair = await produceRepairProposal(dbgPacket, deps, { proposedAt: FIXED_TS, geneId: 'fg_driver' });
      line(`[debugger] produceRepairProposal: ${repair.ok ? 'OK' : 'FAIL ' + repair.errors.join('; ')} (gene ${repair.failure_gene?.id})`);
      if (!repair.ok || !repair.proposal) return fail(await doRollback(story, ws.root, line));

      // ── Step 9: Apply the repair ────────────────────────────────────────────
      const repairDiff = path.join(ws.root, '_repair.diff');
      fs.writeFileSync(repairDiff, REPAIR_PATCH);
      const repairApplied = applyProposal({ ws, diffPath: repairDiff, changedFiles: repair.proposal.changed_files, contract: applyContract, oracle });
      line(`[apply-repair] ${repairApplied.applied ? 'APPLIED' : 'BLOCKED'}`);
      if (!repairApplied.applied) return fail(await doRollback(story, ws.root, line));

      // ── Step 10: Re-validate — expected PASS ────────────────────────────────
      const verdict2 = runValidation(ws, validationCommands);
      line(`[validate-2] ${verdict2.passed ? 'PASS' : 'FAIL'} (expected PASS — a+b)`);
      repaired = true;
      finalPassed = verdict2.passed;
      if (!verdict2.passed) return fail(await doRollback(story, ws.root, line));
    }

    // ── Step 11: Progress summary (029.6) ─────────────────────────────────────
    const summary = summarizeProgress({
      story_id: STORY_ID, epic_id: 'EPIC-DRIVER',
      attempt: repaired ? 2 : 1, attempt_budget: 3,
      validation_result: finalPassed ? 'pass' : 'fail',
      status: 'checkpointed', next_action: 'checkpoint',
    });
    line(`[supervisor] progress: ${summary.summary}`);

    // ── Step 12: Checkpoint ───────────────────────────────────────────────────
    line(`  transition VALIDATION→CHECKPOINT = ${canTransition('VALIDATION', 'CHECKPOINT')}`);
    const checkpoint: DriverCheckpoint = {
      story_id: STORY_ID,
      developer_provider_kind: devProposalKind,
      debugger_provider_kind: 'scripted',
      preflight_decision: preflight.verdict,
      first_validation: verdict1.passed ? 'passed' : 'failed',
      repaired,
      final_validation: finalPassed ? 'passed' : 'failed',
      progress_summary: summary.summary,
      final_checkpoint_marker: 'CHECKPOINT REACHED ✓',
    };
    line('');
    line(JSON.stringify(checkpoint, null, 2));
    line('CHECKPOINT REACHED ✓');
    return { reached_checkpoint: finalPassed, checkpoint, rolled_back: false, used_real_provider: false, output: logs.join('\n') };
  } finally {
    cleanupWorkspace(registry, ws);
  }
}

/** Roll the workspace back on a terminal failure (029.7). Returns true if attempted. */
async function doRollback(story: StoryRecord, cwd: string, line: (s: string) => void): Promise<boolean> {
  const r = await rollbackWorkspace(story, { cwd, preStoryRef: story.branch ?? 'HEAD' });
  line(`[rollback] ${r.ok ? 'ok' : 'failed: ' + r.error} → restored ${r.restored_to}`);
  return true;
}

// ── STORY-029.8: Live cognition activation (gated, opt-in) ───────────────────
// The real-provider twin of runDriverLoop. Its CORE safety property: when the
// real_api_calls gate is closed OR no key is resolvable, it SKIPS CLEANLY with a
// clear reason and never touches the network — it must not error or crash. When
// the gate is open AND a key resolves, it bootstraps+registers the live adapter
// (handle → adapter, EPIC-028), makes a budget-guarded routed call through the
// gateway (EPIC-011), validates the structured output, and reports budget
// decrement. No secret value ever enters the result or the trace.

/** Read real_api_calls.enabled from policy.yaml (no yaml dep; targeted parse). */
export function readRealApiGate(policyPath: string): boolean {
  try {
    const text = fs.readFileSync(policyPath, 'utf8');
    const m = text.match(/real_api_calls:\s*\n\s*enabled:\s*(true|false)/);
    return m ? m[1] === 'true' : false;
  } catch {
    return false; // fail closed
  }
}

export interface LiveActivationDeps {
  enabled: boolean;                       // the real_api_calls gate
  handle: TypedSecretHandle;              // typed broker reference (never the value)
  resolveSecret: SecretResolver;          // Secret Broker resolver
  baseUrl: string;
  routing: RoutingConfig;
  httpClient?: RealProviderHttpClient;    // injectable — tests pass a mock; never real in CI
  budget?: BudgetConfig;
  storyId?: string;
}

export interface LiveActivationResult {
  skipped: boolean;
  reason: string;
  registered: ProviderRegistrationRecord[];
  routed_ok: boolean;
  output_valid: boolean;
  budget_usage: { calls: number; tokens: number };
}

const SKIP = (reason: string): LiveActivationResult =>
  ({ skipped: true, reason, registered: [], routed_ok: false, output_valid: false, budget_usage: { calls: 0, tokens: 0 } });

/**
 * Gate-aware live activation. Returns a clean SKIP (no network, no throw) unless
 * the gate is open AND a non-empty key resolves. STORY-029.8 core safety property.
 */
export async function liveActivation(deps: LiveActivationDeps): Promise<LiveActivationResult> {
  const storyId = deps.storyId ?? 'STORY-EVAL-TODO';
  if (!deps.enabled) return SKIP('live cognition skipped: gate closed (real_api_calls=false)');

  let key = '';
  try { key = await deps.resolveSecret(deps.handle); } catch { key = ''; }
  if (!key) return SKIP(`live cognition skipped: no key resolvable for ${deps.handle.handle_id}`);

  // Gate open + key present → bootstrap + register the live adapter (handle → adapter).
  const registry = new ProviderRegistry();
  const boot = bootstrapLiveProviders({
    enabled: true,
    providers: [{ provider_id: deps.handle.provider, handle: deps.handle, base_url: deps.baseUrl }],
    registry,
    resolveSecret: deps.resolveSecret,
    httpClient: deps.httpClient,
  });

  // Budget-guarded routed call through the gateway (EPIC-011 guardedCall).
  const guard = new BudgetGuard(storyId, deps.budget);
  const routeRefs = resolveProviderIdsFromConfig(deps.routing, 'developer', 'patch_generation');
  const providerId = routeRefs.length ? (parseModelRef(routeRefs[0])?.provider_id ?? routeRefs[0]) : deps.handle.provider;
  const provider = registry.has(providerId) ? registry.get(providerId) : registry.get(deps.handle.provider);

  const req: ModelGatewayRequest = {
    request_id: `live-${storyId}`, target_agent: 'developer', task_class: 'patch_generation',
    story_id: storyId, task_packet: { objective: 'tiny CLI greenfield story (live activation proof)' },
  };
  const result = await guardedCall(guard, provider, req);
  const outputValid = result.ok && !!result.output && validateStructuredOutput('developer', result.output).ok;

  return {
    skipped: false,
    reason: result.ok ? 'live routed call completed' : `routed call failed: ${result.errors.join('; ')}`,
    registered: boot.registered,
    routed_ok: result.ok,
    output_valid: outputValid,
    budget_usage: guard.usage,        // budget decremented by the routed call
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  if (process.argv.includes('--live')) {
    // CI-safe by construction: gate is read from policy.yaml; key from the broker
    // (here: OPENAI_API_KEY env). With the gate closed or no key, this SKIPS cleanly.
    const policyPath = path.resolve(fileURLToPath(import.meta.url), '../../configs/policy.yaml');
    const enabled = readRealApiGate(policyPath);
    const handle: TypedSecretHandle = { handle_id: 'provider.openai.default', handle_type: 'api_key', provider: 'openai' };
    const resolveSecret: SecretResolver = async () => process.env.OPENAI_API_KEY ?? '';
    const routing: RoutingConfig = { agents: { developer: { primary: 'openai/gpt-5.5' }, debugger: { primary: 'openai/gpt-5.5' } } };
    const r = await liveActivation({ enabled, handle, resolveSecret, baseUrl: 'https://api.openai.com/v1', routing });
    if (r.skipped) {
      console.log(`[live] ${r.reason}`);
      console.log('[live] gate-closed/no-key path is a clean no-op — zero network, zero cost.');
      process.exit(0);
    }
    console.log(`[live] ${r.reason}  registered=${r.registered.map(x => x.provider_id).join(',')}  routed_ok=${r.routed_ok}  output_valid=${r.output_valid}  budget=${JSON.stringify(r.budget_usage)}`);
    process.exit(r.routed_ok && r.output_valid ? 0 : 1);
  }
  const result = await runDriverLoop({ print: true });
  process.exit(result.reached_checkpoint ? 0 : 1);
}

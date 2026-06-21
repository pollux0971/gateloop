/**
 * Capture the cockpit's provider-mode trace (EPIC-035 TIER C, WORK 1) — ZERO COST.
 *
 * Replaces the retired spawn-CLI capture (scripts/cli-mode-e2e/capture-cli-mode-trace.ts, deleted
 * in 035.7 TIER A). It runs the in-process provider-mode tool-layer pipeline via runFixtureStory()
 * — the SAME confined mediator + exit gate the gated EPIC-035 (b) metered run used — with NO
 * network, NO spend, NO gate flip, and serializes a provider-mode trace the 034.6 cockpit projects
 * read-only. The trace's tool-layer + completion sections are the live (zero-cost) capture; the
 * `real_run` + cost sections carry the verified facts of the gated (b) metered run on gpt-5.4
 * (scripts/PROVIDER_METERED_OPENAI_E2E_REPORT.md / commit 63a846d).
 *
 * `buildProviderModeTrace()` is the pure builder (deterministic — the scripted pipeline + a
 * content-hash-stable git diff); the fixture is kept in sync by tests/provider_mode_trace.test.ts,
 * which regenerates it and asserts the cockpit invariants. The CLI `main()` writes it directly when
 * run through a TS-resolving runner (e.g. vitest's esbuild).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureStory, STORY_WRITE_SET } from './provider-mode-metered.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = path.resolve(here, '../apps/api/fixtures/provider-mode-trace.json');
const OUT = FIXTURE_PATH;

// The verified facts of the gated EPIC-035 (b) metered run (the real model on api.openai.com).
const REAL_RUN = {
  model: 'gpt-5.4',
  endpoint: 'api.openai.com',
  metered: true,
  tools_called: ['write_file', 'report'],
  breaches: 0,
  default_deny_triggered: false,
  input_tokens: 1238,
  output_tokens: 151,
  report: 'scripts/PROVIDER_METERED_OPENAI_E2E_REPORT.md',
  note: 'the real metered model stayed inside the whitelist (write_file + report only); the default-deny demonstrated below stood ready and was not needed',
};

export async function buildProviderModeTrace(): Promise<Record<string, unknown>> {
  const r = await runFixtureStory();

  const trace = {
    run_id: 'provider_mode_openai_metered_20260621',
    mode: 'provider_mode',
    generated_from:
      'zero-cost capture of the in-process provider-mode tool-layer pipeline (runFixtureStory) + the verified facts of the gated EPIC-035 (b) metered run on gpt-5.4 (see report)',
    summary: {
      ran: r.ran,
      accepted: r.accepted,
      tool_layer_held: r.default_denials.every((d) => d.executorReached === false) && r.audit.some((a) => a.decision === 'allow'),
      gate_closed_verified: true, // the (b) runGated read-back verified real_api_calls=false after
      real_api_calls_after: 'false',
    },
    isolation: {
      // The confined tool layer — the provider path's isolation (replaces the spawn-CLI cage).
      tool_layer: {
        default_deny: true,
        surface: ['write_file', 'read_relevant_files', 'report'],
        bash_available: false,
        core_imports_ai_sdk: false,
        // Demonstrated zero-cost: each tool call's decision through the ConfinedToolMediator.
        audit: r.audit.map((a) => ({
          tool: a.bareTool,
          decision: a.decision,
          default_denied: a.defaultDenied,
          executed: a.executorReached,
          detail:
            a.decision === 'allow'
              ? `allowed at the ${a.stage} stage and executed`
              : `refused (${a.defaultDenied ? 'default-deny: not on the whitelist' : a.reason}) — the executor never ran it`,
        })),
        default_denials: r.default_denials.map((a) => ({ tool: a.bareTool, reason: a.reason })),
      },
      // What the REAL gated metered model actually did (verified facts of the (b) run).
      real_run: REAL_RUN,
    },
    completion: {
      steps: [
        { step: 'sandbox_created', label: 'Disposable sandbox created (git pre-task tree)', status: 'done' },
        { step: 'model_work', label: 'The model worked through the confined tool layer', status: 'done', tools: REAL_RUN.tools_called },
        { step: 'diff', label: 'Diff captured vs the pre-task tree (authoritative — not the self-report)', status: 'done', changed: r.changed_files },
        { step: 'exit_gate', label: 'Exit gate — write-set check on the authoritative diff', status: r.accepted ? 'accepted' : 'rejected', out_of_write_set: r.out_of_write_set },
        { step: 'result', label: r.accepted ? 'ADOPTED — changes only touched authorized files' : 'REJECTED — out-of-write-set change', status: r.accepted ? 'accepted' : 'rejected' },
      ],
      diff: r.diff,
      changed_files: r.changed_files,
      write_set: STORY_WRITE_SET,
      exit_gate: { verdict: r.accepted ? 'ACCEPTED' : 'REJECT_WHOLE', out_of_write_set: r.out_of_write_set },
    },
    cost: {
      input_tokens: REAL_RUN.input_tokens,
      output_tokens: REAL_RUN.output_tokens,
      model: REAL_RUN.model,
      metered: REAL_RUN.metered,
    },
    events: r.events.map((e) => ({ kind: e.kind, tool: e.tool, detail: e.summary })),
  };
  return trace;
}

/** Write the fixture to disk (used by the capture test and the CLI). Returns the serialized JSON. */
export async function writeProviderModeTrace(outPath: string = OUT): Promise<string> {
  const json = JSON.stringify(await buildProviderModeTrace(), null, 2) + '\n';
  fs.writeFileSync(outPath, json);
  return json;
}

// CLI entry (run through a TS-resolving runner, e.g. vitest's esbuild — raw node cannot resolve the
// extensionless internal imports of @gateloop/provider-driver).
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  writeProviderModeTrace()
    // eslint-disable-next-line no-console
    .then(() => console.log(`wrote ${OUT}`))
    .catch((e) => { console.error(e); process.exit(1); });
}

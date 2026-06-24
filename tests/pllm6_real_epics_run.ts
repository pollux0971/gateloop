/**
 * STORY-PLLM.6 — Gated real E2E runner: one small idea → real epics via the REAL author.
 *
 * THIS FILE IS NOT A test file — the root vitest include only collects files ending in
 * ".test.ts", so this runner NEVER executes in CI. It is opt-in only: `runRealEpics` refuses
 * unless `optIn === true`, and the CLI `main()` requires `PLLM6_REAL=1`. The default/CI
 * path everywhere else stays the SCRIPTED author (zero cost).
 *
 * The key is resolved ONLY by the Secret Broker's child process (subprocessEnvSource sources
 * .env in a child shell and prints just the value) and used ONLY inside createMeteredEngine's
 * closure — it never enters this process's logs, the report, or agent context. The broker also
 * redacts any resolved value from text. Kill-switch: an AbortSignal (wired to SIGINT) stops the
 * loop between stages.
 *
 * Offline-testable: `runRealEpics` takes the real-author deps by INJECTION, so the gating
 * guard (tests/pllm6_gating.test.ts) proves opt-in refusal + kill-switch with a scripted
 * engine and zero spend. Design: docs/architecture/28 §4.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPlanningFlowService } from '../apps/api/src/planning';
import { createMeteredEngine, pickMeteredBackend } from '@gateloop/provider-driver';
import { SecretBroker, subprocessEnvSource } from '@gateloop/secret-broker';
import type { RealAuthorDeps } from '@gateloop/planning-steward';

export interface RealRunDeps {
  /** gateloop/ root (configs/skills live here). */
  repo: string;
  /** The real-author wiring (production: createMeteredEngine over the broker). Injected so
   *  the offline guard can pass a scripted engine and spend nothing. */
  realAuthorDeps: RealAuthorDeps;
  /** One small idea to drive brief→prd→architecture→epics. */
  idea: string;
  /** MUST be true to run — opt-in gate. */
  optIn: boolean;
  /** Kill-switch — checked before each stage; aborts the loop with no further provider call. */
  signal?: AbortSignal;
  /** Safety cap on stage iterations (default 6). */
  maxStages?: number;
  /** Re-author attempts after the first per stage (forwarded to the author loop; default service default = 2). */
  maxRewrites?: number;
}

export interface StageEvidence {
  stageId: string;
  advanced: boolean;
  attempts: number;
  docLength: number;
  docPreview: string;
  /** On a blocked/give-up stage, the checklist items the model never satisfied. */
  failingItems: string[];
}

export interface RealRunReport {
  ok: boolean;
  aborted: boolean;
  idea: string;
  stages: StageEvidence[];
  /** The authored epics document, when the epics stage converged. */
  epicsDoc: string | null;
}

/**
 * Drive one idea through the planning pipeline with the REAL author (mode:'real').
 * Pure of provider specifics — the engine is whatever realAuthorDeps builds. Refuses to
 * run unless opt-in; honors the abort signal between stages.
 */
export async function runRealEpics(deps: RealRunDeps): Promise<RealRunReport> {
  if (!deps.optIn) {
    throw new Error('PLLM.6 real run is opt-in: refusing to spend (set optIn / PLLM6_REAL=1).');
  }
  const svc = createPlanningFlowService({ repo: deps.repo, realAuthorDeps: deps.realAuthorDeps });
  const stages: StageEvidence[] = [];
  let epicsDoc: string | null = null;
  const maxStages = deps.maxStages ?? 6;

  for (let i = 0; i < maxStages; i++) {
    if (deps.signal?.aborted) {
      return { ok: false, aborted: true, idea: deps.idea, stages, epicsDoc };
    }
    const r = await svc.author({ idea: deps.idea, mode: 'real', maxRewrites: deps.maxRewrites });
    stages.push({
      stageId: r.stageId ?? '(none)',
      advanced: r.advanced,
      attempts: r.attempts,
      docLength: (r.doc || '').length,
      docPreview: (r.doc || '').slice(0, 240),
      failingItems: (r.failing_items || []).map((it) => it.text),
    });
    if (r.stageId === 'epics' && r.advanced) epicsDoc = r.doc;
    if (!r.advanced) break; // blocked / give-up
    if (r.to == null) break; // flow complete
  }

  return { ok: epicsDoc != null, aborted: false, idea: deps.idea, stages, epicsDoc };
}

// ─────────────────────────── report writer ───────────────────────────

export interface CostNote {
  backendId: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Render the run report markdown. NEVER includes a key (only docs + token/cost note). */
export function renderReport(report: RealRunReport, cost: CostNote, at: string): string {
  const lines: string[] = [];
  lines.push('# STORY-PLLM.6 — Real-run evidence (gated, opt-in, NOT a CI test)');
  lines.push('');
  lines.push(`- Captured at: ${at}`);
  lines.push(`- Idea (single variable): ${JSON.stringify(report.idea)}`);
  lines.push(`- Backend / model: \`${cost.backendId}\` / \`${cost.model}\``);
  lines.push(`- Converged to epics: ${report.ok ? 'YES' : 'no'} · aborted: ${report.aborted ? 'YES' : 'no'}`);
  lines.push('');
  lines.push('## Token / cost note');
  lines.push(`- Provider calls: ${cost.calls}`);
  lines.push(`- Input tokens: ${cost.inputTokens} · Output tokens: ${cost.outputTokens}`);
  lines.push('');
  lines.push('## Stages');
  for (const s of report.stages) {
    lines.push(`### ${s.stageId} — advanced=${s.advanced} attempts=${s.attempts} docLen=${s.docLength}`);
    if (s.failingItems.length > 0) {
      lines.push('Unsatisfied checklist items:');
      for (const fi of s.failingItems) lines.push(`- ${fi}`);
    }
    lines.push('```');
    lines.push(s.docPreview);
    lines.push('```');
  }
  if (report.epicsDoc) {
    lines.push('## Produced epics artifact');
    lines.push('```markdown');
    lines.push(report.epicsDoc);
    lines.push('```');
  }
  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────── CLI ───────────────────────────────

const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

async function main(): Promise<void> {
  const optIn = process.env.PLLM6_REAL === '1';
  if (!optIn) {
    // Fail-closed: never spend without an explicit opt-in.
    console.error('PLLM.6 gated runner: set PLLM6_REAL=1 to opt in (refusing to spend). No call made.');
    process.exit(2);
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, '..'); // gateloop/
  const idea =
    process.env.PLLM6_IDEA ||
    // NOTE: prose only, no angle-bracket command syntax — the bmad-prd checklist treats any
    // "<...>" as an unfilled placeholder (no-tbd), so describing commands in words keeps the
    // model from emitting bracketed tokens that would never pass.
    'A tiny single-user offline CLI URL shortener with three commands. The shorten command takes ' +
      'a URL argument, stores it in a local JSON file, and prints a 6-character base62 code. The ' +
      'recent command lists the 10 most recently shortened URLs with their codes and creation ' +
      'timestamps. The resolve command takes a code argument and prints the original URL. No server, ' +
      'no auth, no network — just a single local data file. Primary users: a developer on their own ' +
      'machine. In scope: the three commands plus local persistence; out of scope: a web UI, ' +
      'multi-user support, and analytics. Write everything in prose with no placeholder tokens.';
  const backendId = process.env.PLLM6_BACKEND || 'openai';
  const model = process.env.PLLM6_MODEL || 'gpt-4o-mini';
  const maxRewrites = Number.parseInt(process.env.PLLM6_MAXREWRITES || '4', 10);
  const envFile = process.env.PLLM6_ENVFILE || path.resolve(repo, '..', '.env');

  // The AI SDK is injected, never top-level imported (kept uninstalled in CI). Loaded here.
  const { streamText } = (await import('ai')) as { streamText: (o: unknown) => { fullStream: AsyncIterable<{ type: string; totalUsage?: { inputTokens?: number; outputTokens?: number }; usage?: { inputTokens?: number; outputTokens?: number } }> } };
  const { createOpenAI } = (await import('@ai-sdk/openai')) as { createOpenAI: (o: { apiKey: string }) => (m: string) => unknown };

  // The key is resolved by the broker's CHILD process — this process never reads .env.
  const broker = new SecretBroker(subprocessEnvSource({ envFile }));
  const cost: CostNote = { backendId, model, calls: 0, inputTokens: 0, outputTokens: 0 };

  // Wrap streamText to tally usage from finish parts (no key ever flows here).
  const wrappedStreamText = (o: unknown) => {
    const res = streamText(o);
    const orig = res.fullStream;
    const teed = (async function* () {
      for await (const p of orig) {
        if (p.type === 'finish') {
          cost.calls++;
          const u = p.totalUsage ?? p.usage ?? {};
          cost.inputTokens += u.inputTokens ?? 0;
          cost.outputTokens += u.outputTokens ?? 0;
        }
        yield p;
      }
    })();
    return { fullStream: teed };
  };

  const realAuthorDeps: RealAuthorDeps = {
    buildEngine: async () =>
      createMeteredEngine({
        spec: pickMeteredBackend(backendId),
        model,
        broker,
        streamText: wrappedStreamText as never,
        modelFactory: (apiKey: string, modelId: string) => createOpenAI({ apiKey })(modelId),
      }),
  };

  const controller = new AbortController();
  process.on('SIGINT', () => {
    console.error('\nkill-switch: SIGINT — aborting after the current stage.');
    controller.abort();
  });

  console.error(`PLLM.6 real run: backend=${backendId} model=${model} maxRewrites=${maxRewrites} — driving brief→epics …`);
  const report = await runRealEpics({ repo, realAuthorDeps, idea, optIn, signal: controller.signal, maxRewrites });

  const at = new Date().toISOString();
  const md = broker.redact(renderReport(report, cost, at)); // redact any resolved secret, belt-and-braces
  const out = path.resolve(repo, 'docs', 'PLLM6_REAL_RUN_REPORT.md');
  fs.writeFileSync(out, md);
  console.error(
    `PLLM.6 real run done: ok=${report.ok} aborted=${report.aborted} calls=${cost.calls} ` +
      `tokens(in/out)=${cost.inputTokens}/${cost.outputTokens} → ${out}`,
  );
  process.exit(report.ok ? 0 : 1);
}

if (isMain) {
  main().catch((e) => {
    // Never print a key; surface only the error message.
    console.error('PLLM.6 real run failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

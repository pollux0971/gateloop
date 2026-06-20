/**
 * STORY-034.5 Stage 3 — gated: run REAL Claude Code inside the proven cage.
 *
 * Flow (all automatic): build cage image → Layer-2 auto-gate (cage has no secrets) → resolve
 * the OAuth token via the broker (never printed) → start the filtering proxy → under runGated
 * (auto open→run→close+verify) spawn real Claude Code headless in the cage on a trivial story
 * → parse its stream for the observation log + usage → diff /work vs the pre-delegation tree →
 * apply the exit-gate write-set crux (diff authoritative; out-of-write-set rejects the whole).
 *
 * Costs subscription credits. Safety: Layer-2 gate is a hard precondition (leak → abort, no
 * spawn); --max-budget-usd inner cap + docker timeout + BudgetLedger; the token flows
 * broker→process.env→docker -e passthrough (never in argv/logs); every printed line is
 * token-redacted. real_api_calls is opened/closed/verified by runGated.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInCage, buildDockerCageArgv } from '../../packages/external-agent/src/osCage.ts';
import { readClaudeOAuthToken } from '@gateloop/secret-broker';
import { runGated, BudgetLedger } from '@gateloop/gate-control';
import { WorkspaceRegistry, createDisposableWorkspace, seedFile, commitAll, collectDiffAgainstHead, cleanupWorkspace } from '@gateloop/workspace-manager';
import { proveLayer2 } from './prove-layer2.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = 'cage-claude:latest';
const PROXY_PORT = 8889;
const PROXY_URL = `http://host.docker.internal:${PROXY_PORT}`;
const policyPath = path.resolve(here, '../../configs/policy.yaml');
const OUT = `/data/python/codeharness_eval_output/cli_mode_claude_${process.env.RUN_TS || 'run'}`;
fs.mkdirSync(OUT, { recursive: true });

// Diff → authoritative changed-file set (same rule as agent-delegate.diffFileSet).
function diffFileSet(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    let m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { files.add(m[2]); continue; }
    m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') files.add(m[1]);
  }
  return [...files].sort();
}

function fail(msg: string): never { console.error(`\nABORT: ${msg}`); process.exit(1); }

// ── 1. cage image ────────────────────────────────────────────────────────────────
execFileSync('bash', [path.join(here, 'build-claude-cage-image.sh'), IMAGE], { stdio: 'inherit' });

// ── 2. Layer-2 auto-gate (hard precondition) ──────────────────────────────────────
console.log('\n[gate] Layer-2 — proving the cage has no secrets before spawn…');
const gate = proveLayer2();
for (const r of gate.results) console.log(`  ${r.held ? 'HELD' : 'FAIL'} ${r.invariant}`);
if (!gate.held) fail('Layer-2 breach — cage can reach a host secret. Not spawning Claude.');
console.log('[gate] Layer-2 HELD → spawn permitted.');

// ── 3. resolve OAuth token via broker (value NEVER printed) ────────────────────────
let TOKEN: string;
try {
  const res = readClaudeOAuthToken();
  if (res.expired) fail('OAuth token is expired — re-run `claude setup-token`.');
  TOKEN = res.token;
} catch (e) { fail(`could not resolve OAuth token from ~/.claude: ${(e as Error).message}`); }
process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN; // for docker -e passthrough (not in argv)
const redact = (s: string) => (TOKEN ? s.split(TOKEN).join('[REDACTED-TOKEN]') : s);
console.log(`[broker] OAuth token resolved (${TOKEN.length} chars) and set for cage env passthrough — never logged.`);

// ── 4. filtering proxy (Layer 1, set-and-use) ──────────────────────────────────────
const proxy = spawn(process.execPath, [path.join(here, 'anthropic-proxy.mjs'), String(PROXY_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const proxyLog: string[] = [];
proxy.stderr.on('data', (d) => proxyLog.push(String(d)));
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('proxy did not start')), 5000);
  proxy.stdout.on('data', (d) => { if (String(d).includes('PROXY_LISTENING')) { clearTimeout(t); resolve(); } });
});
console.log(`[proxy] filtering forward-proxy up on ${PROXY_PORT} (allowlist api.anthropic.com).`);

// ── 5. sandbox /work — pre-delegation git tree ─────────────────────────────────────
const reg = new WorkspaceRegistry();
const ws = createDisposableWorkspace(reg, { story_id: 'cli-mode-S1' });
seedFile(ws, 'README.md', '# text toolkit\n\nA tiny pure-ESM utility kit.\n');
commitAll(ws, 'pre-delegation tree');
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
const WRITE_SET = ['slugify.mjs'];
const PROMPT = [
  'You are working in the current directory (/work).',
  'Create exactly one file named slugify.mjs that exports a function:',
  '  export function slugify(input) { /* ... */ }',
  'slugify lowercases the input, trims whitespace, replaces every run of non-alphanumeric',
  'characters with a single hyphen, and strips leading/trailing hyphens. Pure ESM, no deps.',
  'Write ONLY slugify.mjs. Do not create or modify any other file. Do not run extra commands.',
].join('\n');

if (process.env.DRY_RUN) {
  proxy.kill('SIGTERM');
  cleanupWorkspace(reg, ws);
  console.log('\n[DRY_RUN] imports loaded · Layer-2 gate held · token resolved · proxy up · sandbox ready. NOT spawning Claude. (zero cost)');
  process.exit(0);
}

// ── 6. runGated: spawn REAL Claude Code in the cage ────────────────────────────────
console.log('\n[gated] opening real_api_calls via runGated and spawning real Claude Code…');
const budget = new BudgetLedger(Number(process.env.EVAL_BUDGET_USD ?? 5));
let cage: { status: number; stdout: string; stderr: string; timedOut: boolean } | undefined;
const gated = await runGated(async () => {
  cage = runInCage({
    image: IMAGE,
    sandboxRoot: ws.root,
    command: [
      // Seed the non-secret onboarding config into the writable HOME (claude no-ops headless
      // without it), then exec claude with the prompt as $1 (avoids embedding it in the shell).
      '/bin/sh', '-c',
      'cp /opt/claude-config/.claude.json "$HOME/.claude.json" 2>/dev/null || printf \'{"hasCompletedOnboarding":true}\' > "$HOME/.claude.json"; '
        + 'exec /opt/claude/claude -p "$1" --output-format stream-json --verbose --permission-mode bypassPermissions --max-budget-usd 1 --add-dir /work',
      'sh', PROMPT,
    ],
    passthroughEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
    authEnv: { HOME: '/tmp' }, // claude state to ephemeral /tmp, NOT /work (keeps the diff clean)
    proxyUrl: PROXY_URL,
    disableTelemetry: true,
    user: `${uid}:${gid}`,
    timeoutMs: 300_000,
  });
  return cage;
}, { policyPath, budget, env: { CI: process.env.CI } });

// ── 7. stop proxy ──────────────────────────────────────────────────────────────────
proxy.kill('SIGTERM');
console.log(`[gated] ran=${gated.ran} gate_closed_verified=${gated.gateClosedVerified} reason="${gated.reason}"`);
fs.writeFileSync(path.join(OUT, 'proxy.log'), proxyLog.join(''));

if (!gated.ran || !cage) { console.log('[gated] run did not execute (gate refused).'); process.exit(0); }

// ── 8. parse claude stream → observation + usage ───────────────────────────────────
const lines = cage.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
const events: Record<string, unknown>[] = [];
for (const l of lines) { try { events.push(JSON.parse(l)); } catch { /* skip partial */ } }
fs.writeFileSync(path.join(OUT, 'claude-stream.jsonl'), redact(cage.stdout));
fs.writeFileSync(path.join(OUT, 'claude-stderr.log'), redact(cage.stderr));

const observed: string[] = [];
let usage: unknown = null;
let resultText = '';
for (const e of events) {
  const type = e.type as string;
  if (type === 'assistant' || type === 'user') {
    const content = (e.message as { content?: unknown[] })?.content ?? [];
    for (const c of content as Record<string, unknown>[]) {
      if (c.type === 'tool_use') observed.push(`tool_use:${c.name}${c.name === 'Bash' ? ` -> ${redact(String((c.input as { command?: string })?.command ?? '')).slice(0, 120)}` : ''}`);
    }
  }
  if (type === 'result') { usage = (e as { usage?: unknown }).usage ?? null; resultText = redact(String((e as { result?: string }).result ?? '')); }
}

// ── 9. exit gate (write-set crux) ───────────────────────────────────────────────────
const diff = collectDiffAgainstHead(ws);
fs.writeFileSync(path.join(OUT, 'delegation.diff'), diff);
const changed = diffFileSet(diff);
const outOfWriteSet = changed.filter((f) => !WRITE_SET.includes(f));
const accepted = changed.length > 0 && outOfWriteSet.length === 0;

// ── report ──────────────────────────────────────────────────────────────────────────
console.log('\n──── ISOLATION (observation stream — what Claude actually ran) ────');
console.log(observed.length ? observed.map((o) => '  ' + o).join('\n') : '  (no tool_use events parsed)');
console.log('\n──── COMPLETION ────');
console.log('  changed files (from diff, authoritative):', changed.join(', ') || '(none)');
console.log('  result:', resultText.slice(0, 200));
console.log('\n──── EXIT GATE (write-set crux) ────');
console.log(`  write_set=${JSON.stringify(WRITE_SET)} out_of_write_set=${JSON.stringify(outOfWriteSet)}`);
console.log(`  verdict: ${accepted ? 'ACCEPTED (diff within write-set)' : outOfWriteSet.length ? 'REJECTED_WHOLE (out-of-write-set)' : 'REJECTED (empty diff)'}`);
console.log('\n──── COST ────');
console.log('  usage:', JSON.stringify(usage));
console.log('\n──── GATE ────');
const gateNow = fs.readFileSync(policyPath, 'utf8').match(/real_api_calls:\s*\n\s*enabled:\s*(true|false)/)?.[1];
console.log(`  gate_closed_verified=${gated.gateClosedVerified}  real_api_calls now: ${gateNow}`);

fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({
  ran: gated.ran, gate_closed_verified: gated.gateClosedVerified, gate_now: gateNow,
  observed, changed, out_of_write_set: outOfWriteSet, accepted, usage, layer2_held: gate.held,
}, null, 2));
console.log(`\noutput: ${OUT}`);
cleanupWorkspace(reg, ws);
process.exit(0);

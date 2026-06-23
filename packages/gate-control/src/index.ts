/**
 * @gateloop/gate-control — harness-managed real_api_calls gating (plan §0).
 *
 * Replaces the human `sed` flow: the harness opens the gate before a gated run and
 * ALWAYS closes it after — and READS BACK to verify the close actually took. That
 * read-back is the direct defense against the 6/15 incident (a silent sed failure
 * left the gate "closed" in belief but open in fact for days).
 *
 * "Full auto" means the program guardrails are the only line of defense, so every
 * one of them is fixture-proven (see index.test.ts):
 *   1. per-run TOKEN CAP    — hard stop once a run crosses its token budget;
 *   2. KILL SWITCH          — global halt; no gated run may start;
 *   3. BUDGET CEILING       — cumulative USD across runs; refuse a new run over it;
 *   4. AUTO-CLOSE + verify   — the gate is closed after every run and read-back-checked;
 *   5. SILENT-FAILURE detect — a write that does not take is surfaced LOUDLY, never silent;
 *   6. CI NEVER GATED        — under CI (ci_override), gated never runs even if enabled:true.
 *
 * Pure/deterministic and dependency-free; all file IO is injectable so the
 * guardrails are provable on a temp policy with zero cost and zero real API calls.
 */
import * as fs from 'node:fs';

export interface GateState {
  enabled: boolean;
  killSwitch: boolean;
  ciOverride: boolean;
}

/** Injectable file IO — lets silent-failure detection be proven without touching the real policy.yaml. */
export interface GateIO {
  read(path: string): string;
  write(path: string, content: string): void;
}
export const defaultGateIO: GateIO = {
  read: (p) => fs.readFileSync(p, 'utf8'),
  write: (p, c) => fs.writeFileSync(p, c),
};

// Anchored to the real_api_calls block so we never flip an unrelated `enabled:`.
const ENABLED_RE = /(real_api_calls:\s*\n\s*enabled:\s*)(true|false)/;
const KILL_RE = /(real_api_calls:[\s\S]*?\n\s*kill_switch:\s*)(true|false)/;
const CIOV_RE = /(real_api_calls:[\s\S]*?\n\s*ci_override:\s*)(true|false)/;

/** Read the gate triplet from policy.yaml. Missing fields default to the safe value
 *  (enabled:false, killSwitch:false, ciOverride:false). */
export function readGate(policyPath: string, io: GateIO = defaultGateIO): GateState {
  const s = io.read(policyPath);
  const en = ENABLED_RE.exec(s);
  const kl = KILL_RE.exec(s);
  const ci = CIOV_RE.exec(s);
  return {
    enabled: en ? en[2] === 'true' : false,
    killSwitch: kl ? kl[2] === 'true' : false,
    ciOverride: ci ? ci[2] === 'true' : false,
  };
}

export interface GateWriteResult {
  ok: boolean;
  /** True only when a read-back confirmed the file now holds the intended value. */
  verified: boolean;
  /** The value the file actually holds after the write (the read-back). */
  actual: boolean;
  error?: string;
}

/**
 * Set real_api_calls.enabled, then READ BACK and verify — never trust the write
 * blindly. A write that does not take (file lock, permission, regex miss) returns
 * `verified:false` + an `error`, NOT a silent success. This is the 6/15 defense.
 */
export function setGateEnabled(policyPath: string, enabled: boolean, io: GateIO = defaultGateIO): GateWriteResult {
  let src: string;
  try {
    src = io.read(policyPath);
  } catch (e) {
    return { ok: false, verified: false, actual: false, error: `read failed: ${(e as Error).message}` };
  }
  if (!ENABLED_RE.test(src)) {
    return { ok: false, verified: false, actual: false, error: 'real_api_calls.enabled not found in policy' };
  }
  const next = src.replace(ENABLED_RE, `$1${enabled}`);
  try {
    io.write(policyPath, next);
  } catch (e) {
    return { ok: false, verified: false, actual: false, error: `write failed: ${(e as Error).message}` };
  }
  // READ BACK — the verification that catches silent failures.
  const after = readGate(policyPath, io).enabled;
  if (after !== enabled) {
    return {
      ok: false,
      verified: false,
      actual: after,
      error: `gate write NOT verified: wanted enabled=${enabled} but file still reads ${after} (silent-failure averted)`,
    };
  }
  return { ok: true, verified: true, actual: after };
}

export interface GateDecision {
  allowed: boolean;
  reason: string;
}

/**
 * The effective gating decision. CI never runs gated; the kill switch hard-stops;
 * a disabled gate stays closed. Pure — given a state + env it always decides the same.
 */
export function isGatedAllowed(state: GateState, env: { CI?: string } = {}): GateDecision {
  if (state.killSwitch) return { allowed: false, reason: 'kill switch engaged — no gated run may start' };
  if (state.ciOverride && env.CI) return { allowed: false, reason: 'CI environment — gated never runs in CI (ci_override)' };
  if (!state.enabled) return { allowed: false, reason: 'real_api_calls disabled' };
  return { allowed: true, reason: 'gate open · no kill switch · not CI' };
}

/**
 * STORY-TRUST.2 (ADR-0013): the cumulative USD budget is a COST KNOB, not a security wall.
 * The operator sets the ceiling and may raise it or remove it entirely (pass `Infinity` to
 * disable — see seedBudgetLedgerFromProjectCost for the uncapped case). NOTHING backstops it:
 * with no ceiling, nothing else catches overspend. It is a quality/cost control the operator
 * chooses, not a protection the system promises. The logic is unchanged — only the framing.
 *
 * Cumulative USD budget across runs. Refuses a new run once the ceiling is reached
 * (or would be crossed by the run's estimate). */
export class BudgetLedger {
  private spentUsd: number;
  private ceilingUsd: number;
  constructor(ceilingUsd: number, initialSpentUsd = 0) {
    this.ceilingUsd = ceilingUsd;
    this.spentUsd = initialSpentUsd;
  }
  canStart(estimateUsd = 0): GateDecision {
    if (this.spentUsd >= this.ceilingUsd) {
      return { allowed: false, reason: `budget ceiling reached: $${this.spentUsd.toFixed(4)} / $${this.ceilingUsd}` };
    }
    if (this.spentUsd + estimateUsd > this.ceilingUsd) {
      return { allowed: false, reason: `run estimate would exceed ceiling: $${(this.spentUsd + estimateUsd).toFixed(4)} / $${this.ceilingUsd}` };
    }
    return { allowed: true, reason: `within budget: $${this.spentUsd.toFixed(4)} / $${this.ceilingUsd}` };
  }
  record(usd: number): void { this.spentUsd += usd; }
  spent(): number { return this.spentUsd; }
  remaining(): number { return Math.max(0, this.ceilingUsd - this.spentUsd); }
}

/**
 * STORY-TRUST.2 (ADR-0013): the per-run token cap is a COST KNOB the operator tunes, not a
 * security wall. Set it high (or wrap it so it never trips) and nothing backstops it — there
 * is no second layer catching a runaway run. Quality/cost control, operator's choice; the
 * mechanism (stop at the cap) is unchanged, only the framing is demoted.
 *
 * Per-run token cap. Once the cap is crossed, `record` returns false and the run stops
 * making further model calls. */
export class TokenCapGuard {
  private total = 0;
  private isKilled = false;
  private reason = '';
  private cap: number;
  constructor(cap: number) { this.cap = cap; }
  /** Record usage; returns true while under cap, false once the cap is hit (caller stops). */
  record(tokens: number): boolean {
    this.total += tokens;
    if (this.total >= this.cap) {
      this.isKilled = true;
      this.reason = `token cap reached: ${this.total} / ${this.cap}`;
      return false;
    }
    return true;
  }
  allowed(): boolean { return !this.isKilled; }
  killed(): boolean { return this.isKilled; }
  used(): number { return this.total; }
  killReason(): string { return this.reason; }
}

export interface GatedRunOptions {
  policyPath: string;
  /** Cumulative budget across runs; refuses to start if over ceiling. */
  budget?: BudgetLedger;
  /** This run's USD estimate, checked against the ceiling before opening. */
  estimateUsd?: number;
  /** Environment for the CI-never-gated check; defaults to process.env. */
  env?: { CI?: string };
  io?: GateIO;
}

export interface GatedRunResult<T> {
  ran: boolean;
  reason: string;
  result?: T;
  /** True when the gate is confirmed CLOSED after the run (read-back). */
  gateClosedVerified: boolean;
}

/**
 * Run a gated function with automatic open/close. This is the human-replacement:
 *
 *   budget/kill/CI checks → OPEN (verify) → run fn → **finally** CLOSE (verify).
 *
 * The gate is ALWAYS closed in `finally` regardless of how `fn` ends, and the close
 * is READ-BACK-verified. If the close cannot be verified the run THROWS a loud
 * CRITICAL error — never returning as if all is well while the gate may be open
 * (the 6/15 silent-failure defense). Refused runs (kill/CI/budget/open-failure)
 * never open the gate, so they report gateClosedVerified:true.
 */
export async function runGated<T>(fn: () => Promise<T>, opts: GatedRunOptions): Promise<GatedRunResult<T>> {
  const io = opts.io ?? defaultGateIO;
  const env = opts.env ?? { CI: process.env.CI };

  // Budget ceiling first — refuse before opening anything.
  if (opts.budget) {
    const b = opts.budget.canStart(opts.estimateUsd ?? 0);
    if (!b.allowed) return { ran: false, reason: b.reason, gateClosedVerified: true };
  }

  // Kill switch / CI check against current policy (evaluated as if we were to open).
  const pre = readGate(opts.policyPath, io);
  const decision = isGatedAllowed({ ...pre, enabled: true }, env);
  if (!decision.allowed) return { ran: false, reason: decision.reason, gateClosedVerified: true };

  // OPEN + verify.
  const open = setGateEnabled(opts.policyPath, true, io);
  if (!open.verified) {
    return { ran: false, reason: `failed to open gate: ${open.error}`, gateClosedVerified: !open.actual };
  }

  let result: T | undefined;
  let fnError: unknown;
  let close: GateWriteResult | undefined;
  try {
    result = await fn();
  } catch (e) {
    fnError = e;
  } finally {
    // ALWAYS close + verify, no matter how fn ended.
    close = setGateEnabled(opts.policyPath, false, io);
  }

  // The 6/15 defense takes priority over anything fn threw: if we cannot confirm the
  // gate is closed, fail LOUDLY so the open gate is never mistaken for closed.
  if (!close || !close.verified) {
    throw new Error(
      `CRITICAL: gate auto-close NOT verified after run — ${close?.error ?? 'unknown'}. ` +
      `Gate may be left OPEN; manual verification required.`,
    );
  }
  if (fnError) throw fnError;

  return { ran: true, reason: 'gated run completed; gate auto-closed and verified', result, gateClosedVerified: true };
}

// ── STORY-GATE.3: policy-change classifier (gate only guardrail-weakening changes) ──
//
// ADR-025: most policy edits are the USER's decision (routing, model, budget numbers,
// skill toggles, non-guardrail config) and should apply-and-log without a stop. Only a
// change that WEAKENS an agent guardrail (loosen write-set, disable default-deny, widen
// tools, lower isolation, enable real_api_calls) must STOP. The classifier is explicit
// and CONSERVATIVE: if it cannot prove a change is benign, it treats it as
// guardrail-weakening and stops (fail-closed — the gate faces the agent's safety).

/** Keys that touch an agent guardrail. A change here is scrutinised for weakening. */
const GUARDRAIL_KEY =
  /real_api_calls|kill_switch|default[._-]?deny|write[._-]?set|allowed_write|allowed_tools|\btools\b|isolation|network|egress|sandbox|container|profile|secret|protected|promotion|permission|bash|shell|sudo|confinement/i;

/** Keys that are clearly the user's own, non-guardrail config → apply-and-log. */
const BENIGN_KEY =
  /routing|model|provider|budget|theme|\bui\b|notification|timeout|retry|temperature|max_tokens|maxtokens|skill/i;

export interface PolicyKeyChange { key: string; before: unknown; after: unknown }

export interface PolicyChangeClassification {
  decision: 'stop' | 'apply_and_log';
  weakensGuardrail: boolean;
  changedKeys: string[];
  /** Per-key reasons for the stop (empty when apply_and_log). */
  reasons: string[];
}

/** Flatten an object to dotted-path leaves (arrays compared as JSON). */
function flatten(obj: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
      else out[key] = v;
    }
  } else {
    out[prefix] = obj;
  }
  return out;
}

/** Diff two policy objects → the leaf keys whose value changed. */
export function diffPolicy(before: Record<string, unknown>, after: Record<string, unknown>): PolicyKeyChange[] {
  const a = flatten(before), b = flatten(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changes: PolicyKeyChange[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changes.push({ key: k, before: a[k], after: b[k] });
  }
  return changes;
}

/** Does a single guardrail-key change WEAKEN the guardrail? Conservative: unknown → true. */
function weakensGuardrail(c: PolicyKeyChange): { weakens: boolean; reason: string } {
  const k = c.key.toLowerCase();
  const before = c.before, after = c.after;
  // real_api_calls.enabled — INVERTED semantics: enabling spend (false→true) weakens;
  // disabling (true→false) strengthens. (kill_switch handled just below.)
  if (/real_api/.test(k) && !/kill_switch/.test(k)) {
    if (before === false && after === true) return { weakens: true, reason: `${c.key}: spending enabled (false→true)` };
    if (before === true && after === false) return { weakens: false, reason: '' }; // spend disabled = strengthen
    return { weakens: true, reason: `${c.key}: ambiguous real_api change → conservative stop` };
  }
  // default-deny / confinement: a protective guard where true=safe. true→false weakens.
  if (/default[._-]?deny|confinement/.test(k)) {
    if (before === true && after === false) return { weakens: true, reason: `${c.key}: guard turned off (true→false)` };
    if (before === false && after === true) return { weakens: false, reason: '' }; // guard turned ON = strengthen
    return { weakens: true, reason: `${c.key}: ambiguous guardrail change → conservative stop` };
  }
  if (/kill_switch/.test(k)) {
    return before === true && after === false
      ? { weakens: true, reason: `${c.key}: kill-switch disabled` }
      : { weakens: false, reason: '' };
  }
  // write-set / allowed_tools / tools: weaken if the set grew or gained shell/bash
  if (/write[._-]?set|allowed_write|allowed_tools|\btools\b/.test(k)) {
    const bs = JSON.stringify(before ?? ''); const as = JSON.stringify(after ?? '');
    if (/bash|shell|sudo|\*\*/i.test(as) && !/bash|shell|sudo|\*\*/i.test(bs)) return { weakens: true, reason: `${c.key}: added shell/broad-glob access` };
    if (as.length > bs.length) return { weakens: true, reason: `${c.key}: scope widened` };
    if (as.length < bs.length) return { weakens: false, reason: '' }; // narrowed = strengthen
    return { weakens: true, reason: `${c.key}: scope changed → conservative stop` };
  }
  // network / egress / sandbox / isolation / container / profile / secret / protected / promotion / permission
  if (/network|egress/.test(k)) {
    return before === false && after === true
      ? { weakens: true, reason: `${c.key}: network/egress opened` }
      : (before === true && after === false ? { weakens: false, reason: '' } : { weakens: true, reason: `${c.key}: ambiguous → conservative stop` });
  }
  if (/sandbox/.test(k)) {
    return before === true && after === false
      ? { weakens: true, reason: `${c.key}: sandbox disabled` }
      : { weakens: false, reason: '' };
  }
  // any other guardrail key change is conservatively a stop
  return { weakens: true, reason: `${c.key}: guardrail-relevant change → conservative stop` };
}

/**
 * STORY-GATE.3: classify a policy change. apply_and_log when EVERY changed key is clearly
 * benign (the user's own config); stop when ANY changed key weakens a guardrail OR is not
 * provably benign (conservative / fail-closed). Pure + deterministic.
 */
export function classifyPolicyChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): PolicyChangeClassification {
  const changes = diffPolicy(before, after);
  const changedKeys = changes.map(c => c.key);
  const reasons: string[] = [];

  for (const c of changes) {
    if (GUARDRAIL_KEY.test(c.key)) {
      const w = weakensGuardrail(c);
      if (w.weakens) reasons.push(w.reason);
    } else if (BENIGN_KEY.test(c.key)) {
      // clearly the user's own config → fine
    } else {
      // unknown key, not provably benign → conservative stop
      reasons.push(`${c.key}: unrecognised policy key → conservative stop (unsure ⇒ treat as guardrail-weakening)`);
    }
  }

  const weakens = reasons.length > 0;
  return { decision: weakens ? 'stop' : 'apply_and_log', weakensGuardrail: weakens, changedKeys, reasons };
}

// ── STORY-SH.1: seed a per-run BudgetLedger from the durable project cost ledger ──
//
// The project-level tier (harness-core ProjectRunState.cost_ledger) feeds the per-run
// tier by SEEDING a BudgetLedger with the cumulative spend via its existing
// `initialSpentUsd` arg — reuse, NOT a new ledger type. So a per-run BudgetLedger's
// canStart()/remaining() already account for everything spent in prior runs against the
// project ceiling. Structural input (no harness-core import).
export interface ProjectCostLedgerView { cumulative_usd: number; project_budget_usd: number | null }

export function seedBudgetLedgerFromProjectCost(ledger: ProjectCostLedgerView): BudgetLedger {
  // Uncapped project → use Infinity ceiling (per-run TokenCapGuard still bounds a single run).
  const ceiling = ledger.project_budget_usd ?? Infinity;
  return new BudgetLedger(ceiling, ledger.cumulative_usd); // <- reuse initialSpentUsd
}

/**
 * @gateloop/api — cockpit read helpers (make every console page live).
 *
 * Pure functions over injected directory paths (repo / builder / fixtures) so the route
 * handlers stay thin and the logic is testable against a temp dir. Each returns a `source`
 * field ('live' | 'sample') so the UI can label honestly. CONFIG/TRACKER are live; things
 * with no offline live source (usage meter, live failure genes, pending gates, reviewer
 * directions) fall back to fixtures, flagged 'sample'. Read-only: never writes any file,
 * never touches real_api_calls/policy. The builder/ tracker is the sibling of gateloop/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface CockpitCtx {
  /** gateloop/ repo root (configs live here). */
  repo: string;
  /** builder/ dir (sibling of repo) — holds tracker/tracker_state.json. */
  builder: string;
  /** apps/api/fixtures dir — sample fallback data. */
  fixtures: string;
}

type Dict = Record<string, unknown>;

function cfg(ctx: CockpitCtx, rel: string): Dict {
  return (parseYaml(fs.readFileSync(path.join(ctx.repo, rel), 'utf8')) as Dict) ?? {};
}
function fx<T = Dict>(ctx: CockpitCtx, name: string): T {
  return JSON.parse(fs.readFileSync(path.join(ctx.fixtures, name), 'utf8')) as T;
}
function tracker(ctx: CockpitCtx): Dict | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(ctx.builder, 'tracker', 'tracker_state.json'), 'utf8')) as Dict;
  } catch {
    return null;
  }
}

// ── Gates (READ-ONLY — no toggle path anywhere) ───────────────────────────────
export interface GateView {
  id: string; label: string; enabled: boolean; human_only: true;
  kill_switch?: boolean; ci_override?: boolean; note: string;
}
export function readGates(ctx: CockpitCtx): { source: 'live'; gates: GateView[] } {
  const policy = cfg(ctx, 'configs/policy.yaml');
  const rac = (policy.real_api_calls as Dict) ?? {};
  const t = tracker(ctx);
  const blocked = new Set<string>(((t?.global_gates_blocked_until_implemented as string[]) ?? []));
  const derived = (id: string, label: string): GateView => ({
    id, label, enabled: false, human_only: true,
    note: blocked.has(id) ? 'blocked until implemented (human-only)' : 'human-only',
  });
  return {
    source: 'live',
    gates: [
      { id: 'real_api_calls', label: 'real_api_calls', enabled: Boolean(rac.enabled), human_only: true,
        kill_switch: Boolean(rac.kill_switch), ci_override: Boolean(rac.ci_override),
        note: 'human-only · cockpit cannot toggle (EPIC-GATE server boundary)' },
      derived('sudo_broker_runtime', 'sudo'),
      derived('bypass_workspace_runtime', 'bypass'),
      derived('stable_promotion', 'promote'),
    ],
  };
}

// ── Backlog (tracker stories[]) ────────────────────────────────────────────────
export interface BacklogStory {
  story_id: string; epic_id?: string; status: string; depends_on: string[];
  parallelism_class?: string; attempts?: number; attempt_budget?: number;
  branch?: string | null; blocked_reason?: string | null; last_result?: string | null;
}
export function readBacklog(ctx: CockpitCtx): {
  source: 'live' | 'sample';
  run: Dict; counts: Record<string, number>; stories: BacklogStory[];
} {
  const t = tracker(ctx);
  if (!t || !Array.isArray(t.stories)) {
    return { source: 'sample', run: { active: false, scope: '' }, counts: {}, stories: [] };
  }
  const stories: BacklogStory[] = (t.stories as Dict[]).map((s) => ({
    story_id: String(s.story_id), epic_id: s.epic_id as string, status: String(s.status),
    depends_on: (s.depends_on as string[]) ?? [], parallelism_class: s.parallelism_class as string,
    attempts: s.attempts as number, attempt_budget: s.attempt_budget as number,
    branch: (s.branch as string | null) ?? null, blocked_reason: (s.blocked_reason as string | null) ?? null,
    last_result: (s.last_result as string | null) ?? null,
  }));
  const counts: Record<string, number> = {};
  for (const s of stories) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const run = (t.run as Dict) ?? {};
  return {
    source: 'live',
    run: { active: run.active, scope: run.scope, current_target: run.current_target, last_completed: run.last_completed },
    counts, stories,
  };
}

// ── Pipeline (derived kanban: lanes by status, waves by depends_on, admission) ──
const LANE_OF: Record<string, string> = {
  todo: 'todo', in_progress: 'in_progress', validating: 'validating', debugging: 'debugging',
  passed: 'validating', checkpointed: 'done', done: 'done', blocked: 'blocked', escalated: 'blocked',
};
export function derivePipeline(ctx: CockpitCtx): {
  source: 'live' | 'sample';
  lanes: Record<string, BacklogStory[]>;
  waves: Record<string, string[]>;
  admission: Array<{ story_id: string; status: string; reason: string; parallelism_class?: string }>;
} {
  const b = readBacklog(ctx);
  const lanes: Record<string, BacklogStory[]> = { todo: [], in_progress: [], validating: [], debugging: [], blocked: [], done: [] };
  for (const s of b.stories) (lanes[LANE_OF[s.status] ?? 'todo'] ??= []).push(s);
  const byId = new Map(b.stories.map((s) => [s.story_id, s]));
  const cache = new Map<string, number>();
  const level = (id: string, seen: Set<string> = new Set()): number => {
    if (cache.has(id)) return cache.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const s = byId.get(id);
    if (!s || !s.depends_on?.length) { cache.set(id, 0); return 0; }
    const l = 1 + Math.max(0, ...s.depends_on.map((d) => (byId.has(d) ? level(d, seen) : 0)));
    cache.set(id, l); return l;
  };
  const waves: Record<string, string[]> = {};
  for (const s of b.stories) { const l = String(level(s.story_id)); (waves[l] ??= []).push(s.story_id); }
  const admission = b.stories
    .filter((s) => s.blocked_reason)
    .map((s) => ({ story_id: s.story_id, status: s.status, reason: String(s.blocked_reason), parallelism_class: s.parallelism_class }));
  return { source: b.source, lanes, waves, admission };
}

// ── Checkpoints (tracker.checkpoints else fixture) ─────────────────────────────
export function readCheckpoints(ctx: CockpitCtx): { source: 'live' | 'sample'; checkpoints: unknown[] } {
  const t = tracker(ctx);
  if (Array.isArray(t?.checkpoints) && (t!.checkpoints as unknown[]).length) {
    return { source: 'live', checkpoints: t!.checkpoints as unknown[] };
  }
  try { const f = fx<Dict>(ctx, 'checkpoints.json'); return { source: 'sample', checkpoints: (f.checkpoints as unknown[]) ?? [] }; }
  catch { return { source: 'sample', checkpoints: [] }; }
}

// ── Budget (caps live from settings.yaml; usage sample offline) ────────────────
export function readBudget(ctx: CockpitCtx): {
  source: 'live'; caps: Dict; caps_source: 'live'; usage: Dict; usage_source: 'sample';
} {
  const s = cfg(ctx, 'configs/settings.yaml');
  const budget = (s.budget as Dict) ?? {};
  const caps = {
    per_story_tokens: budget.max_tokens_per_story ?? null,
    per_run_tokens: budget.max_tokens_per_run ?? null,
    per_story_calls: budget.max_calls_per_story ?? null,
    per_run_calls: budget.max_calls_per_run ?? null,
  };
  let usage: Dict = { tokens: 0, cost: 0, calls: 0 };
  try { usage = (fx<Dict>(ctx, 'budget.json').usage as Dict) ?? usage; } catch { /* keep zeros */ }
  return { source: 'live', caps, caps_source: 'live', usage, usage_source: 'sample' };
}

// ── Quality bar (policy.yaml + settings.review) ────────────────────────────────
export function readQualityBar(ctx: CockpitCtx): {
  source: 'live'; required_checks: string[]; coverage_threshold: number | null; review: Dict;
} {
  const p = cfg(ctx, 'configs/policy.yaml');
  const s = cfg(ctx, 'configs/settings.yaml');
  const qb = (p.quality_bar as Dict) ?? {};
  return {
    source: 'live',
    required_checks: (qb.required_checks as string[]) ?? [],
    coverage_threshold: (qb.coverage_threshold as number | null) ?? null,
    review: (s.review as Dict) ?? {},
  };
}

// ── Failure bank (governance live; genes sample offline) ───────────────────────
export function readFailureBank(ctx: CockpitCtx): { source: 'live'; governance: Dict; genes: unknown[]; genes_source: 'sample' } {
  const g = cfg(ctx, 'configs/failure_bank.yaml');
  const bank = (g.bank as Dict) ?? {};
  const esc = (g.escalation as Dict) ?? {};
  let genes: unknown[] = [];
  try { genes = (fx<Dict>(ctx, 'failure_bank.json').genes as unknown[]) ?? []; } catch { /* none */ }
  return {
    source: 'live',
    governance: { max_active_genes: bank.max_active_genes, recurring_pattern_threshold: esc.recurring_pattern_threshold },
    genes, genes_source: 'sample',
  };
}

// ── Human gates (tracker.pending_human_gate + fixture sample) ──────────────────
export function readHumanGates(ctx: CockpitCtx): { source: 'live' | 'sample'; gates: Dict[] } {
  const t = tracker(ctx);
  const live: Dict[] = [];
  if (t?.pending_human_gate) live.push({ ...(t.pending_human_gate as Dict), source: 'live' });
  let sample: Dict[] = [];
  try { sample = ((fx<Dict>(ctx, 'human_gates.json').gates as Dict[]) ?? []).map((g) => ({ ...g, source: 'sample' })); } catch { /* none */ }
  return { source: live.length ? 'live' : 'sample', gates: [...live, ...sample] };
}

// ── Reviewer directions (sample only offline) ──────────────────────────────────
export function readReviewerDirections(ctx: CockpitCtx, storyId?: string): { source: 'sample'; directions: Dict[] } {
  let directions: Dict[] = [];
  try {
    const f = fx<Dict>(ctx, 'reviewer_directions.json');
    directions = ((f.directions as Dict[]) ?? []).filter((d) => !storyId || d.story_id === storyId);
  } catch { /* none */ }
  return { source: 'sample', directions };
}

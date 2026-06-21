/**
 * STORY-UST.4 — A/B metrics for the ponytail effectiveness proof.
 *
 * Pure, dependency-light helpers shared by the offline scripted A/B (tests) and the
 * single gated real-model A/B (scripts/ust4-ab-gated). They compute the three-fold the
 * proof requires from a patch proposal:
 *   - net added LOC + changed-file count  (the "code↓" axis)
 *   - whether it stayed additive/within-set (a Validator-equivalent "correctness held")
 *   - friction signals (additive-gate rejections / escalations)
 * Honest note: scripted providers ignore the prompt, so the BEHAVIOURAL reduction
 * (a model writing less when ponytail is mounted) is proven only by the gated arm.
 * These helpers prove the MEASUREMENT + GATES + §3.3 coordination are sound either way.
 */

export interface MeasuredEdit {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  content?: string;
}
export interface MeasuredProposal {
  ok: boolean;
  changed_files?: string[];
  edits?: MeasuredEdit[];
  /** escalation / rejection signals (friction). */
  escalated?: boolean;
  rejected_paths?: string[];
  errors?: string[];
}

/** Net added lines: count lines of create/modify content (the code the patch adds). */
export function patchLoc(p: MeasuredProposal): number {
  const edits = p.edits ?? [];
  let loc = 0;
  for (const e of edits) {
    if (e.operation === 'delete') continue;
    if (typeof e.content === 'string' && e.content.length > 0) {
      loc += e.content.split('\n').filter(l => l.trim().length > 0).length;
    }
  }
  return loc;
}

/** Number of files the patch touches. */
export function patchFileCount(p: MeasuredProposal): number {
  return (p.changed_files ?? p.edits?.map(e => e.path) ?? []).length;
}

export interface ArmResult {
  label: string;
  ok: boolean;
  loc: number;
  files: number;
  /** friction: did this arm hit a gate rejection or escalation? */
  friction: boolean;
  errors: string[];
}

export function measureArm(label: string, p: MeasuredProposal): ArmResult {
  return {
    label,
    ok: p.ok,
    loc: patchLoc(p),
    files: patchFileCount(p),
    friction: Boolean(p.escalated) || (p.rejected_paths?.length ?? 0) > 0 || (!p.ok && (p.errors?.length ?? 0) > 0),
    errors: p.errors ?? [],
  };
}

export interface AbVerdict {
  /** code↓: ponytail arm wrote no more than the baseline. */
  loc_not_increased: boolean;
  files_not_increased: boolean;
  /** correctness held: both arms produced an accepted patch. */
  correctness_held: boolean;
  /** no added friction: ponytail arm did not add gate rejections / escalations. */
  no_added_friction: boolean;
  /** all three hold. */
  three_fold_pass: boolean;
  baseline: ArmResult;
  ponytail: ArmResult;
}

/** The three-fold verdict: code↓ ∧ correctness held ∧ no added friction. */
export function abVerdict(baseline: ArmResult, ponytail: ArmResult): AbVerdict {
  const loc_not_increased = ponytail.loc <= baseline.loc;
  const files_not_increased = ponytail.files <= baseline.files;
  const correctness_held = baseline.ok && ponytail.ok;
  const no_added_friction = !ponytail.friction || baseline.friction; // ponytail adds no NEW friction
  return {
    loc_not_increased,
    files_not_increased,
    correctness_held,
    no_added_friction,
    three_fold_pass: loc_not_increased && files_not_increased && correctness_held && no_added_friction,
    baseline,
    ponytail,
  };
}

/**
 * @gateloop/developer-runtime
 *
 * The Developer agent's runtime: define the output contract, validate a returned
 * patch proposal, and (STORY-029.3) actually PRODUCE one by calling the model
 * through agent-core.askModel. Code generation is no longer a stub — the single
 * most critical joint in the system. Safe by construction: an edit outside the
 * write-set is rejected before it ever leaves the agent.
 * Spec: gateloop/docs/agents/03_DEVELOPER_AGENT.md
 */
import { askModel, type AskModelDeps } from '@gateloop/agent-core';
import type { AgentStructuredOutput } from '@gateloop/model-gateway';

export interface ValidationResult { ok: boolean; errors: string[] }

/** Every Developer turn must return exactly these artifacts. */
export const DEVELOPER_OUTPUT_CONTRACT = [
  'implementation_plan','patch_proposal','changed_files','test_plan','risk_notes','rollback_notes'
] as const;

export function validateDeveloperOutput(out: Record<string, unknown>): ValidationResult {
  const errors = DEVELOPER_OUTPUT_CONTRACT.filter(k => out[k] === undefined || out[k] === null)
    .map(k => `missing developer output: ${k}`);
  return { ok: errors.length === 0, errors };
}

/** changed_files must be ⊆ allowed_write_set (glob). Pre-apply check mirror. */
export function changedFilesWithinWriteSet(changedFiles: string[], allowedWriteSet: string[]): ValidationResult {
  const match = (p: string) => allowedWriteSet.some(g => new RegExp('^' +
    g.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*\*/g,'§').replace(/\*/g,'[^/]*').replace(/§/g,'.*') + '$').test(p));
  const errors = changedFiles.filter(f => !match(f)).map(f => `outside write-set: ${f}`);
  return { ok: errors.length === 0, errors };
}

// ── Patch proposal production (STORY-029.3 — the critical joint) ─────────────

/**
 * STORY-030.2: an acceptance test handed to the Developer. The Developer may
 * READ these (they tell it the bar to clear) but may never author or modify
 * them — that authority belongs to the Assessor (STORY-030.3) / Planning. The
 * generator no longer defines its own bar.
 */
export interface AcceptanceTestRef {
  /** Path of the acceptance-test file (the Developer's write-set must exclude it). */
  path: string;
  /** Optional inline content so the Developer can read the bar without write access. */
  content?: string;
  /** Who authored the acceptance test — never the developer/debugger. */
  source: 'assessor' | 'planning';
}

/** The slice of a Developer Task Packet that producePatchProposal reads. */
export interface DeveloperTaskPacketView {
  story_id?: string;
  story_contract_ref?: string;
  contract_version?: number;
  allowed_write_set: string[];
  acceptance_criteria?: string[];
  /** STORY-030.2: acceptance tests provided to the Developer (read-only). */
  acceptance_tests?: AcceptanceTestRef[];
  /** STORY-030.2: extra acceptance-test paths the Developer must not write. */
  acceptance_test_paths?: string[];
  [k: string]: unknown;
}

/** Glob match (same semantics as the write-set check): ** = any, * = non-slash. */
function globMatch(p: string, glob: string): boolean {
  return new RegExp('^' +
    glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$'
  ).test(p);
}

/**
 * STORY-030.2: the set of paths the Developer is forbidden to author — its own
 * acceptance tests. Union of the explicit acceptance_test_paths and the paths of
 * every acceptance_tests entry in the packet. Deduped.
 */
export function acceptanceTestPathsFromPacket(packet: DeveloperTaskPacketView): string[] {
  return dedupe([
    ...(packet.acceptance_test_paths ?? []),
    ...((packet.acceptance_tests ?? []).map(t => t.path)),
  ]);
}

/** STORY-030.2: acceptance tests the Developer is allowed to READ (never write). */
export function developerReadableTests(packet: DeveloperTaskPacketView): AcceptanceTestRef[] {
  return packet.acceptance_tests ?? [];
}

/**
 * STORY-030.2: reject any changed file that is one of the Developer's own
 * acceptance tests. Returns the violating paths. The generator may read these
 * (they are in the packet) but writing them is a hard boundary violation.
 */
export function rejectDeveloperAuthoredAcceptanceTests(
  changedFiles: string[],
  acceptanceTestPaths: string[],
): ValidationResult {
  const violations = changedFiles.filter(f => acceptanceTestPaths.some(g => globMatch(f, g) || f === g));
  return {
    ok: violations.length === 0,
    errors: violations.map(f => `developer_cannot_author_own_acceptance_tests: ${f}`),
  };
}

/** A single file edit. Additive-first: create/modify are additive; delete is destructive. */
export interface ProposedEdit {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  rationale?: string;
}

const CHANGE_TYPES = ['REBIND', 'INSERT_PREREQ', 'SUBSTITUTE', 'REWIRE', 'BYPASS', 'new_impl'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** Structured patch proposal, conforming to specs/patch_proposal.schema.json (plus
 *  the additive/reversible/edit detail the harness needs to apply it safely). */
export interface PatchProposal {
  proposal_id: string;
  story_id: string;
  contract_id: string;
  contract_version: number;
  summary: string;
  change_type: ChangeType;
  changed_files: string[];
  patch_branch: string;
  patch_diff_path?: string;
  postconditions_claimed: string[];
  validation_commands_run?: string[];
  proposed_at: string;
  status: 'proposed';
  edits: ProposedEdit[];
  rationale_summary: string;
  rollback_notes: string;
  additive: boolean;
  reversible: boolean;
}

export interface ProducePatchProposalOptions {
  /** Injected timestamp for a deterministic proposed_at; defaults to now(). */
  proposedAt?: string;
  /** Patch branch; defaults to story/<story_id>. Never the main branch. */
  patchBranch?: string;
}

export interface ProducePatchProposalResult {
  ok: boolean;
  proposal?: PatchProposal;
  errors: string[];
  /** Paths the model tried to touch outside the write-set — rejected before emit. */
  rejected_paths: string[];
  /** When the model escalated instead of proposing, its raw structured output. */
  escalation?: AgentStructuredOutput;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Produce a patch proposal for a developer task packet (STORY-029.3).
 *
 * Calls the model via agent-core.askModel (config-driven provider; scripted in CI,
 * real later — same interface), parses the response into a structured, schema-
 * conforming PatchProposal, and enforces three safety gates BEFORE the proposal
 * leaves the agent:
 *   1. malformed model output → already rejected inside askModel (ok:false);
 *   2. any edit outside the packet's allowed_write_set → rejected pre-emit;
 *   3. the proposal must be additive (no deletes) and reversible (rollback notes).
 * A self-described rationale summary is attached. Deterministic given the same
 * packet + provider output (+ injected proposed_at).
 */
export async function producePatchProposal(
  packet: DeveloperTaskPacketView,
  deps: AskModelDeps,
  options: ProducePatchProposalOptions = {},
): Promise<ProducePatchProposalResult> {
  const storyId = (packet.story_id as string) ?? 'unknown-story';

  // 1. Ask the model. askModel applies the same malformed-output rejection as fixtures.
  const res = await askModel(
    { role: 'developer', taskClass: 'patch_generation', taskPacket: packet as Record<string, unknown>, storyId },
    deps,
  );
  if (!res.ok || !res.output) {
    return {
      ok: false,
      errors: res.errors.length ? res.errors : ['model returned no usable output'],
      rejected_paths: [],
    };
  }

  // 2. The developer must return a patch_proposal; any other kind is an escalation.
  const out = res.output as { kind?: string } & Record<string, unknown>;
  if (out.kind !== 'patch_proposal') {
    return {
      ok: false,
      errors: [`developer did not produce a patch (kind=${out.kind ?? 'none'}); escalation surfaced`],
      rejected_paths: [],
      escalation: res.output,
    };
  }

  // 3. Normalize the raw output into proposal fields.
  const changedFiles = Array.isArray(out.changed_files) ? (out.changed_files as string[]) : [];
  const edits: ProposedEdit[] = Array.isArray(out.edits)
    ? (out.edits as ProposedEdit[])
    : changedFiles.map((p) => ({ path: p, operation: 'modify' as const }));
  const rollbackNotes = typeof out.rollback_notes === 'string' ? out.rollback_notes : '';
  const rationale = typeof out.rationale_summary === 'string'
    ? out.rationale_summary
    : (typeof out.summary === 'string' ? out.summary : '');

  if (changedFiles.length === 0) {
    return { ok: false, errors: ['proposal has no changed_files'], rejected_paths: [] };
  }

  // 4. PRE-EMIT write-set gate: an edit outside the write-set never leaves the agent.
  const allPaths = dedupe([...changedFiles, ...edits.map((e) => e.path)]);
  const within = changedFilesWithinWriteSet(allPaths, packet.allowed_write_set);
  if (!within.ok) {
    const rejected = allPaths.filter((p) => !changedFilesWithinWriteSet([p], packet.allowed_write_set).ok);
    return {
      ok: false,
      errors: ['edits outside write-set rejected before emit', ...within.errors],
      rejected_paths: rejected,
    };
  }

  // 4b. STORY-030.2: acceptance-test authorship gate. The Developer may READ its
  // acceptance tests (they are in the packet) but never AUTHOR or modify them —
  // a patch that touches its own acceptance tests is rejected before it emits.
  const forbiddenTestPaths = acceptanceTestPathsFromPacket(packet);
  const testGate = rejectDeveloperAuthoredAcceptanceTests(allPaths, forbiddenTestPaths);
  if (!testGate.ok) {
    const rejected = allPaths.filter((p) =>
      forbiddenTestPaths.some((g) => globMatch(p, g) || p === g));
    return {
      ok: false,
      errors: ['developer may not author its own acceptance tests', ...testGate.errors],
      rejected_paths: rejected,
    };
  }

  // 5. Additive + reversible gates.
  const destructive = edits.filter((e) => e.operation === 'delete').map((e) => e.path);
  const additive = destructive.length === 0;
  const reversible = rollbackNotes.trim().length > 0;
  const gateErrors: string[] = [];
  if (!additive) gateErrors.push(`proposal is not additive: deletes ${destructive.join(', ')}`);
  if (!reversible) gateErrors.push('proposal is not reversible: missing rollback_notes');
  if (gateErrors.length) return { ok: false, errors: gateErrors, rejected_paths: [] };

  const changeTypeRaw = typeof out.change_type === 'string' ? out.change_type : 'new_impl';
  const change_type: ChangeType = (CHANGE_TYPES as readonly string[]).includes(changeTypeRaw)
    ? (changeTypeRaw as ChangeType)
    : 'new_impl';

  const proposal: PatchProposal = {
    proposal_id: typeof out.proposal_id === 'string' ? out.proposal_id : `PP-${storyId}-001`,
    story_id: storyId,
    contract_id: packet.story_contract_ref ?? `story_contract:${storyId}`,
    contract_version: typeof packet.contract_version === 'number' ? packet.contract_version : 1,
    summary: (typeof out.summary === 'string' ? out.summary : rationale || `Patch for ${storyId}`).slice(0, 300),
    change_type,
    changed_files: changedFiles,
    patch_branch: options.patchBranch ?? `story/${storyId}`,
    postconditions_claimed: Array.isArray(out.postconditions_claimed)
      ? (out.postconditions_claimed as string[])
      : (packet.acceptance_criteria ?? []),
    proposed_at: options.proposedAt ?? new Date().toISOString(),
    status: 'proposed',
    edits,
    rationale_summary: rationale || `Implements ${storyId} within the allowed write-set.`,
    rollback_notes: rollbackNotes,
    additive,
    reversible,
  };
  return { ok: true, proposal, errors: [], rejected_paths: [] };
}

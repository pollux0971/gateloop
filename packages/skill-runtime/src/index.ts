export interface SkillPackageManifest {
  skill_id: string;
  agent_role: 'planning_steward' | 'supervisor' | 'developer' | 'debugger' | 'reviewer';
  path: string;
}

export function isSkillForRole(skill: SkillPackageManifest, role: SkillPackageManifest['agent_role']): boolean {
  return skill.agent_role === role;
}

import fs from 'node:fs';
import path from 'node:path';

export interface FullSkillManifest {
  skill_id: string;
  agent_role: 'planning_steward' | 'supervisor' | 'developer' | 'debugger' | 'reviewer';
  path: string;
  description?: string;
  version?: number;
  status?: 'draft' | 'needs_tests' | 'registered' | 'quarantined';
  tests?: string[];
  depends_on?: string[];
  /** STORY-GATE.4: user on/off toggle (default true). Toggling is a pure user decision —
   *  instant, NOT gated. A disabled skill is registered but not loaded into the prompt. */
  enabled?: boolean;
  /** STORY-GATE.4: shipped-by-default product skill (e.g. ponytail). Can be DISABLED by the
   *  user but NEVER deleted (reinstallable product content). */
  builtin?: boolean;
}
export interface ValidationResult { ok: boolean; errors: string[] }

/** STORY-GATE.4: a skill is active when enabled !== false (default true). */
export function skillEnabled(m: { enabled?: boolean }): boolean {
  return m.enabled !== false;
}

/** Load and parse a skill's skill.json manifest from its package directory. */
export function loadSkillManifest(skillDir: string): FullSkillManifest {
  const p = path.join(skillDir, 'skill.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as FullSkillManifest;
}

/** A skill package is structurally valid only with these fields + a non-empty tests list. */
export function validateSkillPackage(m: FullSkillManifest): ValidationResult {
  const errors: string[] = [];
  for (const k of ['skill_id', 'agent_role'] as const) if (!m[k]) errors.push(`missing: ${k}`);
  if (!m.tests || m.tests.length === 0) errors.push('skill has no tests/ — cannot be registered');
  return { ok: errors.length === 0, errors };
}

/** The hard gate: a skill without tests is never registerable (returns true = reject). */
export function rejectSkillWithoutTests(m: FullSkillManifest): boolean {
  return !m.tests || m.tests.length === 0;
}

// ── STORY-014.6: role-scoped skill loading ────────────────────────────────────

export interface SkillContent {
  skill_id: string;
  skill_md: string;
  avoid_lines: string[];
  token_estimate: number;
}

/**
 * Return only registered AND enabled skills for the given role.
 * Quarantined, draft, needs_tests, and user-disabled skills are never returned.
 * STORY-GATE.4: the `&& skillEnabled` is the runtime half of the user on/off toggle.
 */
export function selectSkillsForRole(
  manifests: FullSkillManifest[],
  role: FullSkillManifest['agent_role'],
): FullSkillManifest[] {
  return manifests.filter(m => m.agent_role === role && m.status === 'registered' && skillEnabled(m));
}

/**
 * Topological sort: return skills in dependency order (deps before dependents).
 * Throws if a cycle is detected.
 */
export function sortByDependencyOrder(skills: FullSkillManifest[]): FullSkillManifest[] {
  const byId = new Map(skills.map(s => [s.skill_id, s]));
  const result: FullSkillManifest[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (inStack.has(id)) throw new Error(`Dependency cycle detected involving skill: ${id}`);
    const skill = byId.get(id);
    if (!skill) return;
    inStack.add(id);
    for (const dep of skill.depends_on ?? []) visit(dep);
    inStack.delete(id);
    visited.add(id);
    result.push(skill);
  }

  for (const s of skills) visit(s.skill_id);
  return result;
}

/**
 * Read SKILL.md and AVOID lines from .memory.md for a skill at skillsRoot/skill.path.
 */
export function readSkillContent(skill: FullSkillManifest, skillsRoot: string): SkillContent {
  const skillDir = path.join(skillsRoot, skill.path);
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const memoryMdPath = path.join(skillDir, '.memory.md');

  const skill_md = fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, 'utf8') : '';

  let avoid_lines: string[] = [];
  if (fs.existsSync(memoryMdPath)) {
    avoid_lines = fs.readFileSync(memoryMdPath, 'utf8')
      .split('\n')
      .filter(line => line.startsWith('AVOID:'));
  }

  return {
    skill_id: skill.skill_id,
    skill_md,
    avoid_lines,
    token_estimate: Math.ceil((skill_md.length + avoid_lines.join('\n').length) / 4),
  };
}

// ── STORY-UST.1: the live-prompt loader ────────────────────────────────────────
//
// The single source of truth that turns the registered skill catalog into mountable
// content WITH the SKILL.md body — used by BOTH the executor (producePatchProposal →
// askModel → composeSystemPrompt) and the read-only introspection view. Both calling
// the same loader is what keeps the executor's prompt and the introspection view
// isomorphic by construction (ADR-024 §3.2). Pure-ish: reads the skills dir, no clock,
// no network; returns [] on any read error so a missing/[]-catalog never throws.

/** A skill ready to mount into the prompt: name + summary + SKILL.md body + AVOID. */
export interface MountedSkillContent {
  name: string;
  summary?: string;
  /** SKILL.md procedure body, frontmatter stripped. */
  body: string;
  avoid: string[];
  token_estimate: number;
}

/** First non-empty line of a description, trimmed to a one-line summary. */
function firstLine(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const line = s.split('\n').map(x => x.trim()).find(x => x.length > 0);
  return line ? line.replace(/\s+/g, ' ').slice(0, 120) : undefined;
}

/** Strip a leading `---...---` YAML frontmatter block (skill metadata, not procedure). */
function stripFrontmatter(md: string): string {
  return md.replace(/^---[\s\S]*?---\s*/, '').trim();
}

export interface LoadMountedSkillsOptions {
  /** Override the catalog path (defaults to <repoRoot>/skills/skill_manifest.json). */
  manifestPath?: string;
}

/**
 * STORY-UST.1: load the registered skills for a role as mountable, body-carrying
 * content, in dependency order (prerequisites first). Only `status: 'registered'`
 * skills for the role are returned (quarantined/draft/needs_tests are excluded — the
 * same rule as selectSkillsForRole). depends_on is read from each skill's skill.json.
 *
 * `repoRoot` is the gateloop/ root (catalog entry `path` is repo-root-relative, e.g.
 * "skills/developer/ponytail-lazy"), matching readSkillContent / getSkillView usage.
 */
export function loadMountedSkillsForRole(
  role: FullSkillManifest['agent_role'],
  repoRoot: string,
  opts: LoadMountedSkillsOptions = {},
): MountedSkillContent[] {
  const manifestPath = opts.manifestPath ?? path.join(repoRoot, 'skills', 'skill_manifest.json');
  if (!fs.existsSync(manifestPath)) return [];
  let catalog: { skills?: Array<Record<string, unknown>> };
  try {
    catalog = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }

  const entries = (catalog.skills ?? []).filter(
    // STORY-GATE.4: a user-disabled (enabled:false) skill is registered but not mounted.
    s => s.agent_role === role && s.status === 'registered' && (s as { enabled?: boolean }).enabled !== false,
  );

  // Build full manifests (with depends_on + description from each skill.json) so the
  // dependency sort and the bullet summary are accurate.
  const manifests: (FullSkillManifest & { description?: string })[] = [];
  for (const e of entries) {
    // Catalog entries may omit `path`; derive skills/<role>/<name> from the skill_id
    // (the repo convention: "developer.cli-tool-template" → skills/developer/cli-tool-template).
    const id = e.skill_id as string;
    const derived = `skills/${role}/${id.includes('.') ? id.split('.').slice(1).join('.') : id}`;
    const skillPath = (typeof e.path === 'string' && e.path.length > 0) ? e.path : derived;
    let depends_on: string[] = [];
    let description: string | undefined;
    try {
      const sj = loadSkillManifest(path.join(repoRoot, skillPath));
      depends_on = sj.depends_on ?? [];
      description = sj.description;
    } catch {
      // skill.json unreadable → treat as no deps; readSkillContent still gets the body
    }
    manifests.push({
      skill_id: e.skill_id as string,
      agent_role: role,
      path: skillPath,
      status: 'registered',
      depends_on,
      description,
    });
  }

  const ourIds = new Set(manifests.map(m => m.skill_id));
  const ordered = sortByDependencyOrder(manifests).filter(m => ourIds.has(m.skill_id));

  const byId = new Map(manifests.map(m => [m.skill_id, m]));
  return ordered.map(m => {
    const content = readSkillContent(m, repoRoot);
    const body = stripFrontmatter(content.skill_md);
    return {
      name: m.skill_id,
      summary: firstLine(byId.get(m.skill_id)?.description),
      body,
      avoid: content.avoid_lines,
      token_estimate: Math.ceil((body.length + content.avoid_lines.join('\n').length) / 4),
    };
  });
}

// ── STORY-GATE.4: skill mutation policy (user decisions vs the test-gate guardrail) ──
//
// ADR-025 §4c: enable/disable + delete-non-builtin are pure USER decisions (un-gated,
// instant). Two things are NOT user-blocks but guardrails / product rules:
//   - adding a NEW skill still goes through the lifecycle test-gate (an untested skill
//     could steer the agent wrong — like an app store scanning before install);
//   - a builtin skill (ponytail) can be DISABLED but never DELETED (reinstallable).

export interface SkillMutationResult { ok: boolean; error?: string }

/** Toggle a skill on/off — a pure user decision. Returns the updated manifest; NEVER gated. */
export function setSkillEnabled<T extends { enabled?: boolean }>(m: T, enabled: boolean): T {
  return { ...m, enabled };
}

/** Delete policy: a builtin skill is refused (disable it instead); anything else is allowed. */
export function canDeleteSkill(m: { builtin?: boolean; skill_id?: string }): SkillMutationResult {
  if (m.builtin) {
    return { ok: false, error: `builtin skill${m.skill_id ? ` '${m.skill_id}'` : ''} cannot be deleted; disable it instead` };
  }
  return { ok: true };
}

/**
 * Register/add policy: a NEW skill must clear the lifecycle test-gate (have tests). This
 * is an AGENT guardrail, not a user-block — it never depends on who is asking, only on
 * whether the skill is safe to let the agent use. The full gate (tests pass + robustness +
 * leakage) lives in @gateloop/skill-tester; this is the structural precondition.
 */
export function canRegisterSkill(m: FullSkillManifest): SkillMutationResult {
  if (rejectSkillWithoutTests(m)) {
    return { ok: false, error: 'skill has no tests/ — must pass the lifecycle test-gate before registration' };
  }
  return { ok: true };
}

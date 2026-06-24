/**
 * @gateloop/planning-steward — Doc-authoring skill loader
 * STORY-PSKILL.1 (EPIC-PSKILL): load a doc-authoring skill from disk.
 *
 * A doc-authoring skill is a directory under `skills/planning/<name>/` with a
 * fixed convention:
 *
 *   skills/planning/<name>/
 *   ├── SKILL.md       YAML frontmatter (name, description, role) + markdown body
 *   ├── steps/         ordered, just-in-time step files (enumerated by filename)
 *   ├── template.md    the output document's required shape
 *   └── checklist.md   the COMPLETION conditions (evaluated in PSKILL.3)
 *
 * This loader parses that shape into a typed {@link DocSkill}. Per ADR-0013
 * (operator-trust) the loader does NOT gate registration — there is no test-gate,
 * no quarantine, no leakage audit; a skill with no tests/ loads fine. But a
 * missing required file (or malformed frontmatter) THROWS a clear
 * DocSkillLoadError — "registration unvalidated" is operator-trust, NOT silent
 * failure. This relates to the EPIC-014 agent-role skill platform
 * (@gateloop/skill-runtime) but is a SEPARATE registry by design (YAGNI — the
 * two answer different questions; see docs/architecture/27_PLANNING_WORKFLOW_ENGINE.md §2.3).
 * It introduces no access or security gate.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Parsed SKILL.md frontmatter. Required: name, description, role. */
export interface DocSkillFrontmatter {
  name: string;
  description: string;
  role: string;
  /** Any additional declared scalars (e.g. stage, when, inputs) preserved as-is. */
  extra: Record<string, string | null>;
}

/** One ordered step file from steps/. */
export interface DocSkillStep {
  filename: string;
  content: string;
}

/** A fully-loaded doc-authoring skill. */
export interface DocSkill {
  dir: string;
  frontmatter: DocSkillFrontmatter;
  body: string; // SKILL.md content after the frontmatter block
  steps: DocSkillStep[]; // ordered by filename
  template: string; // template.md content
  checklist: string; // checklist.md content
}

/** Thrown on a missing required file or malformed SKILL.md. Never swallowed. */
export class DocSkillLoadError extends Error {
  constructor(message: string) {
    super(`doc_skill: ${message}`);
    this.name = 'DocSkillLoadError';
  }
}

const REQUIRED_FRONTMATTER = ['name', 'description', 'role'] as const;

/** Strip a YAML scalar: surrounding quotes removed; `~`/`null`/empty → null. */
function scalar(raw: string): string | null {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse the leading `---`-delimited YAML frontmatter of a SKILL.md.
 * @throws DocSkillLoadError when the block is missing/unclosed or a required key
 *   is absent/empty.
 */
export function parseSkillFrontmatter(skillMd: string, label: string): { frontmatter: DocSkillFrontmatter; body: string } {
  const lines = skillMd.split('\n');
  // find the opening '---' (first non-blank line must be the delimiter)
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (lines[i].trim() === '---') {
      open = i;
      break;
    }
    throw new DocSkillLoadError(`${label}/SKILL.md: must start with a '---' YAML frontmatter block`);
  }
  if (open === -1) throw new DocSkillLoadError(`${label}/SKILL.md: missing '---' YAML frontmatter block`);

  let close = -1;
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) throw new DocSkillLoadError(`${label}/SKILL.md: unterminated frontmatter (missing closing '---')`);

  const fields: Record<string, string | null> = {};
  for (let i = open + 1; i < close; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) throw new DocSkillLoadError(`${label}/SKILL.md: frontmatter line ${i + 1}: expected "key: value", got "${t}"`);
    const key = line.slice(0, idx).trim();
    if (!key) throw new DocSkillLoadError(`${label}/SKILL.md: frontmatter line ${i + 1}: empty key`);
    if (key in fields) throw new DocSkillLoadError(`${label}/SKILL.md: duplicate frontmatter key '${key}'`);
    fields[key] = scalar(line.slice(idx + 1));
  }

  for (const k of REQUIRED_FRONTMATTER) {
    if (!(k in fields) || fields[k] === null || fields[k] === '') {
      throw new DocSkillLoadError(`${label}/SKILL.md: missing required frontmatter field '${k}'`);
    }
  }

  const extra: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!(REQUIRED_FRONTMATTER as readonly string[]).includes(k)) extra[k] = v;
  }

  return {
    frontmatter: {
      name: fields.name as string,
      description: fields.description as string,
      role: fields.role as string,
      extra,
    },
    body: lines.slice(close + 1).join('\n').trim(),
  };
}

function readRequiredFile(filePath: string, label: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new DocSkillLoadError(`${label}: missing required file '${path.basename(filePath)}'`);
  }
}

/**
 * Load a doc-authoring skill from a directory. Steps are enumerated from steps/
 * in filename order. Per ADR-0013 the load is unvalidated (no test-gate), but a
 * missing required file or malformed SKILL.md throws {@link DocSkillLoadError}.
 * @throws DocSkillLoadError
 */
export function loadDocSkill(skillDir: string): DocSkill {
  const label = path.basename(skillDir);
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    throw new DocSkillLoadError(`'${skillDir}' is not a directory`);
  }

  const skillMd = readRequiredFile(path.join(skillDir, 'SKILL.md'), label);
  const { frontmatter, body } = parseSkillFrontmatter(skillMd, label);
  const template = readRequiredFile(path.join(skillDir, 'template.md'), label);
  const checklist = readRequiredFile(path.join(skillDir, 'checklist.md'), label);

  const stepsDir = path.join(skillDir, 'steps');
  if (!fs.existsSync(stepsDir) || !fs.statSync(stepsDir).isDirectory()) {
    throw new DocSkillLoadError(`${label}: missing required directory 'steps/'`);
  }
  const steps: DocSkillStep[] = fs
    .readdirSync(stepsDir)
    .filter((f) => f.endsWith('.md'))
    .sort() // filename order — zero-padded prefixes (01_, 02_, …) sort deterministically
    .map((filename) => ({ filename, content: fs.readFileSync(path.join(stepsDir, filename), 'utf8') }));

  return { dir: skillDir, frontmatter, body, steps, template, checklist };
}

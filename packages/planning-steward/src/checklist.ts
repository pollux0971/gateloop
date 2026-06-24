/**
 * @gateloop/planning-steward — Completion checker (checklist → passed/total)
 * STORY-PSKILL.3 (EPIC-PSKILL).
 *
 * Parses a skill's checklist.md into individual, evaluable items and evaluates
 * each against a document draft using DETERMINISTIC, STRUCTURAL checks — no LLM
 * judgement (so tests stay deterministic). Reports checklist_passed /
 * checklist_total. A stage is `done` only when every item passes (wired into the
 * workflow state in PSKILL.4); this is a quality control on the OUTPUT, not an
 * access gate on the operator (ADR-0013).
 *
 * Checklist item grammar (one per markdown task-list line):
 *
 *   - [ ] <directive>
 *   - [ ] <human prose> :: <directive>
 *
 * where <directive> is one of the structural check types below. The checkbox
 * mark ([ ] vs [x]) is ignored — pass/fail is decided by evaluating the
 * directive against the doc, never by a self-reported tick. An item whose
 * directive is missing/unrecognised is parsed but is `evaluable:false` and
 * counts as NOT passed (we never claim to have verified what we cannot).
 *
 *   section: <Heading>   doc has a `#…` heading matching <Heading> with non-empty body
 *   no-tbd | no-placeholder   doc has no TBD/TODO/FIXME/XXX and no <…> angle placeholder
 *   contains: <marker>   doc contains the literal <marker> (case-insensitive)
 *   matches: <regex>     doc matches <regex> (case-insensitive; invalid regex → not evaluable)
 *   min-words: <n>       doc has at least <n> whitespace-separated words
 */

/** A parsed + evaluated checklist item. */
export interface ChecklistItem {
  id: string;
  text: string; // the full item text after the checkbox
  directive: { type: string; arg: string } | null; // recognised structural directive, if any
  evaluable: boolean; // whether a known directive was found
  pass: boolean; // structural evaluation result against the doc
}

/** The completion-check result for a checklist against a document draft. */
export interface ChecklistResult {
  items: ChecklistItem[];
  passed: number; // count of items with pass === true
  total: number; // items.length
  complete: boolean; // total > 0 && passed === total
}

const KNOWN_DIRECTIVES = new Set(['section', 'no-tbd', 'no-placeholder', 'contains', 'matches', 'min-words']);
const TASK_LINE = /^\s*[-*]\s+\[[ xX]\]\s*(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.+?)\s*$/;
const PLACEHOLDER = /(\bTBD\b|\bTODO\b|\bFIXME\b|\bXXX\b|<[^>\n]+>)/i;

/** Parse a directive string into { type, arg }, or null if unrecognised. */
function parseDirective(s: string): { type: string; arg: string } | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(':');
  let type: string;
  let arg: string;
  if (colon !== -1) {
    type = trimmed.slice(0, colon).trim().toLowerCase();
    arg = trimmed.slice(colon + 1).trim();
  } else {
    const sp = trimmed.indexOf(' ');
    if (sp === -1) {
      type = trimmed.toLowerCase();
      arg = '';
    } else {
      type = trimmed.slice(0, sp).trim().toLowerCase();
      arg = trimmed.slice(sp + 1).trim();
    }
  }
  if (!KNOWN_DIRECTIVES.has(type)) return null;
  return { type, arg };
}

/** Parse checklist.md into items (no evaluation yet). Non-task lines are ignored. */
export function parseChecklist(checklistMd: string): Array<Pick<ChecklistItem, 'id' | 'text' | 'directive'>> {
  if (typeof checklistMd !== 'string') return [];
  const out: Array<Pick<ChecklistItem, 'id' | 'text' | 'directive'>> = [];
  const lines = checklistMd.split('\n');
  for (const line of lines) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    const sep = text.indexOf(' :: ');
    const directiveStr = sep !== -1 ? text.slice(sep + 4) : text;
    const directive = parseDirective(directiveStr);
    out.push({ id: `item-${out.length + 1}`, text, directive });
  }
  return out;
}

/** Find a `#…` heading matching `name` and return its body text (until next heading). */
function sectionBody(doc: string, name: string): string | null {
  const lines = doc.split('\n');
  const target = name.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (!h) continue;
    if (h[1].trim().toLowerCase() !== target) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (HEADING.test(lines[j])) break;
      body.push(lines[j]);
    }
    return body.join('\n');
  }
  return null;
}

/** Evaluate one parsed directive against the doc (deterministic, structural). */
function evaluateDirective(directive: { type: string; arg: string }, doc: string): boolean {
  switch (directive.type) {
    case 'section': {
      const body = sectionBody(doc, directive.arg);
      return body !== null && body.trim().length > 0;
    }
    case 'no-tbd':
    case 'no-placeholder':
      return !PLACEHOLDER.test(doc);
    case 'contains':
      return directive.arg.length > 0 && doc.toLowerCase().includes(directive.arg.toLowerCase());
    case 'matches': {
      try {
        return new RegExp(directive.arg, 'i').test(doc);
      } catch {
        return false; // invalid regex → not verifiable → not passed (no crash)
      }
    }
    case 'min-words': {
      const n = Number.parseInt(directive.arg, 10);
      if (!Number.isFinite(n)) return false;
      const words = doc.trim().split(/\s+/).filter(Boolean).length;
      return words >= n;
    }
    default:
      return false;
  }
}

/**
 * Parse + evaluate a checklist against a document draft. Empty or malformed
 * checklists report `{ total: 0, passed: 0, complete: false }` (never crash).
 * Fully deterministic — same (checklist, doc) → same result; no LLM.
 */
export function evaluateChecklist(checklistMd: string, doc: string): ChecklistResult {
  const docText = typeof doc === 'string' ? doc : '';
  const parsed = parseChecklist(checklistMd);
  const items: ChecklistItem[] = parsed.map((p) => {
    const evaluable = p.directive !== null;
    const pass = evaluable ? evaluateDirective(p.directive!, docText) : false;
    return { ...p, evaluable, pass };
  });
  const passed = items.filter((i) => i.pass).length;
  const total = items.length;
  return { items, passed, total, complete: total > 0 && passed === total };
}

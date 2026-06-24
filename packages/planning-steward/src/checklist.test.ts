import { describe, it, expect } from 'vitest';
import { parseChecklist, evaluateChecklist } from './checklist.js';

const CHECKLIST = `# Completion checklist
Some prose that is not a task line and must be ignored.

- [ ] Overview present :: section: Overview
- [ ] Functional Requirements present :: section: Functional Requirements
- [ ] no placeholders :: no-tbd
- [ ] has FR markers :: contains: FR-
- [ ] AC in Given/When/Then :: matches: Given .* When .* Then
- [ ] long enough :: min-words: 8
`;

const GOOD_DOC = `# PRD

## Overview
This product does a thing for users.

## Functional Requirements
FR-1: the system shall do X (Given a user When they act Then it responds).
FR-2: the system shall do Y.
`;

describe('STORY-PSKILL.3 — completion checker (checklist → passed/total)', () => {
  it('checklist_parsed_into_individual_items', () => {
    const items = parseChecklist(CHECKLIST);
    expect(items).toHaveLength(6); // only the 6 `- [ ]` lines, prose ignored
    expect(items[0].id).toBe('item-1');
    expect(items[0].directive).toEqual({ type: 'section', arg: 'Overview' });
    expect(items[2].directive).toEqual({ type: 'no-tbd', arg: '' });
    expect(items[3].directive).toEqual({ type: 'contains', arg: 'FR-' });
    expect(items[5].directive).toEqual({ type: 'min-words', arg: '8' });
  });

  it('each_item_evaluated_to_pass_or_fail_structurally', () => {
    const res = evaluateChecklist(CHECKLIST, GOOD_DOC);
    const byText = Object.fromEntries(res.items.map((i) => [i.text.split(' :: ')[0], i.pass]));
    expect(byText['Overview present']).toBe(true); // section exists, non-empty
    expect(byText['Functional Requirements present']).toBe(true);
    expect(byText['no placeholders']).toBe(true); // GOOD_DOC has no TBD/<...>
    expect(byText['has FR markers']).toBe(true); // contains "FR-"
    expect(byText['AC in Given/When/Then']).toBe(true); // regex matches
    expect(byText['long enough']).toBe(true);

    // a doc that FAILS items: missing FR section, has a TBD, no FR markers
    const badDoc = `# PRD\n## Overview\nshort.\nstatus: TBD\n`;
    const bad = evaluateChecklist(CHECKLIST, badDoc);
    const badByText = Object.fromEntries(bad.items.map((i) => [i.text.split(' :: ')[0], i.pass]));
    expect(badByText['Overview present']).toBe(true); // still has Overview
    expect(badByText['Functional Requirements present']).toBe(false); // no FR section
    expect(badByText['no placeholders']).toBe(false); // contains TBD
    expect(badByText['has FR markers']).toBe(false); // no "FR-"
    expect(badByText['AC in Given/When/Then']).toBe(false);

    // an item with an unrecognised/missing directive is parsed but not passable
    const prose = evaluateChecklist('- [ ] the overview should be good\n', GOOD_DOC);
    expect(prose.total).toBe(1);
    expect(prose.items[0].evaluable).toBe(false);
    expect(prose.items[0].pass).toBe(false);
  });

  it('reports_checklist_passed_over_total', () => {
    const all = evaluateChecklist(CHECKLIST, GOOD_DOC);
    expect(all.total).toBe(6);
    expect(all.passed).toBe(6);
    expect(all.complete).toBe(true);

    const partial = evaluateChecklist(CHECKLIST, '# PRD\n## Overview\nshort.\nstatus: TBD\n');
    expect(partial.total).toBe(6);
    expect(partial.passed).toBeLessThan(6);
    expect(partial.passed).toBeGreaterThan(0);
    expect(partial.complete).toBe(false); // not all pass -> not complete
  });

  it('empty_or_malformed_checklist_reports_zero_total_not_crash', () => {
    expect(evaluateChecklist('', GOOD_DOC)).toEqual({ items: [], passed: 0, total: 0, complete: false });
    // prose-only / no task lines -> zero items, no crash
    const proseOnly = evaluateChecklist('# heading\njust paragraphs, no checkboxes\n', GOOD_DOC);
    expect(proseOnly.total).toBe(0);
    expect(proseOnly.complete).toBe(false);
    // malformed inputs do not crash
    expect(() => evaluateChecklist(CHECKLIST, '')).not.toThrow();
    // @ts-expect-error — defensive: non-string checklist handled, no crash
    expect(evaluateChecklist(null, GOOD_DOC).total).toBe(0);
    // an invalid regex directive does not crash — just fails that item
    const badRe = evaluateChecklist('- [ ] x :: matches: (unclosed\n', GOOD_DOC);
    expect(badRe.total).toBe(1);
    expect(badRe.items[0].pass).toBe(false);
  });

  it('evaluation_is_deterministic_no_llm', () => {
    const a = evaluateChecklist(CHECKLIST, GOOD_DOC);
    const b = evaluateChecklist(CHECKLIST, GOOD_DOC);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // stable ordering, no nondeterminism
    // evaluation is synchronous (no async LLM call) and pure
    expect(evaluateChecklist(CHECKLIST, GOOD_DOC)).not.toBeInstanceOf(Promise);
  });
});

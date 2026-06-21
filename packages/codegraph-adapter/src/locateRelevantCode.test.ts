import { describe, it, expect } from 'vitest';
import { locateRelevantCode, extractSymbolHints, NULL_CLIENT, type CodeGraphClient } from './index';

// A hand-rolled client (self-contained; no engine) modelling a small graph:
//   slugify defined in src/slug.ts; src/slug.ts has one dependent src/consumer.ts.
const client: CodeGraphClient = {
  async query(q) {
    if (q.operation === 'symbol_lookup' && q.target === 'slugify') {
      return { locations: [{ file: 'src/slug.ts', line: 1, kind: 'definition' }], impacted_files: [] };
    }
    if (q.operation === 'impact') {
      return { locations: [], impacted_files: ['src/consumer.ts'] };
    }
    return { locations: [], impacted_files: [] };
  },
};

describe('STORY-CW.4: locateRelevantCode (Mode 1 context root)', () => {
  it('fills relevant_files (write-set + located symbol + blast-radius dependents) and do_not_touch', async () => {
    const r = await locateRelevantCode({ writeSetFiles: ['src/slug.ts'], symbols: ['slugify'] }, client);
    expect(r.relevant_files).toContain('src/slug.ts');        // the write-set file
    expect(r.relevant_files).toContain('src/consumer.ts');    // its dependent (located)
    expect(r.do_not_touch).toEqual(['src/consumer.ts']);      // dependent outside the write-set
    expect(r.codegraph_summary).not.toBe('');
    expect(r.codegraph_summary).toMatch(/relevant file/);
    expect(r.codegraph_summary).toMatch(/preserve 1 dependent/);
  });

  it('degrades to the write-set under NULL_CLIENT (seam/fallback holds; still non-empty)', async () => {
    const r = await locateRelevantCode({ writeSetFiles: ['src/slug.ts'], symbols: ['slugify'] }, NULL_CLIENT);
    expect(r.relevant_files).toEqual(['src/slug.ts']);
    expect(r.do_not_touch).toEqual([]);
    expect(r.codegraph_summary).not.toBe('');
  });

  it('extractSymbolHints pulls backtick + camel/Pascal identifiers from prose', () => {
    const hints = extractSymbolHints('Add a method to `FooConfig`; update parseUserInput and the RouterTable.');
    expect(hints).toContain('FooConfig');
    expect(hints).toContain('parseUserInput');
    expect(hints).toContain('RouterTable');
  });
});

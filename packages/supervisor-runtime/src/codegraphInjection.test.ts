import { describe, it, expect } from 'vitest';
import { composeDeveloperTaskPacket, composeDeveloperTaskPacketWithCodegraph } from './index';
import type { CodeGraphClient } from '@gateloop/codegraph-adapter';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTRACT: any = {
  story_id: 'STORY-CWX.1',
  objective: 'Extend `slugify` in src/slug.ts to strip emoji',
  background: '',
  expected_behavior: ['slugify_strips_emoji'],
  allowed_write_set: ['src/slug.ts'],
  acceptance_criteria: ['slugify_strips_emoji'],
  validation_commands: ['pnpm test'],
  rollback_notes: 'revert src/slug.ts',
};

// slugify defined in src/slug.ts; src/slug.ts has one dependent src/consumer.ts.
const fakeClient: CodeGraphClient = {
  async query(q) {
    if (q.operation === 'symbol_lookup' && q.target === 'slugify') {
      return { locations: [{ file: 'src/slug.ts', line: 1, kind: 'definition' }], impacted_files: [] };
    }
    if (q.operation === 'impact') return { locations: [], impacted_files: ['src/consumer.ts'] };
    return { locations: [], impacted_files: [] };
  },
};

describe('STORY-CW.4: Supervisor fills relevant_files/codegraph_summary before dispatch', () => {
  it('plain composeDeveloperTaskPacket leaves the codegraph sections absent (backward compatible)', () => {
    const p = composeDeveloperTaskPacket({ contract: CONTRACT });
    expect(p.relevant_files).toBeUndefined();
    expect(p.codegraph_summary).toBeUndefined();
  });

  it('composeDeveloperTaskPacketWithCodegraph FILLS the previously-empty sections + merges do_not_touch', async () => {
    const p = await composeDeveloperTaskPacketWithCodegraph({ contract: CONTRACT }, fakeClient);
    expect(p.relevant_files).toBeDefined();
    expect(p.relevant_files!.length).toBeGreaterThan(0);
    expect(p.relevant_files).toContain('src/slug.ts'); // the write-set file
    expect(p.relevant_files).toContain('src/consumer.ts'); // located dependent
    expect(p.codegraph_summary).toBeTruthy();
    expect(p.codegraph_summary).toMatch(/relevant file/);
    expect(p.required_files.do_not_touch).toContain('src/consumer.ts'); // blast radius merged
  });
});
// (The real-engine end-to-end of locateRelevantCode lives in @gateloop/codegraph-client's tests,
//  to avoid coupling supervisor-runtime to the engine package; here we prove the packet wiring.)

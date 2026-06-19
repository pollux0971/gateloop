/**
 * WORK B — the Supervisor infers a task's DOMAIN + CONTEXT NEED deterministically
 * from the contract (write-set + complexity), with pure rules (no LLM → Supervisor
 * stays 0 askModel). The router (WORK C) matches these against model capabilities.
 */
import { describe, it, expect } from 'vitest';
import { inferTaskDomains, inferNeedsLongContext, inferTaskSignals, composeDeveloperTaskPacket } from './index';

describe('WORK B — domain inference from the write-set', () => {
  it('a .tsx / apps/web write-set → frontend', () => {
    expect(inferTaskDomains(['apps/web/src/ApiPage.tsx'])).toEqual(['frontend']);
  });
  it('a packages/*.ts write-set → backend', () => {
    expect(inferTaskDomains(['packages/model-gateway/src/index.ts'])).toEqual(['backend']);
  });
  it('a mixed write-set → both domains', () => {
    expect(inferTaskDomains(['apps/web/src/App.tsx', 'packages/api/src/index.ts'])).toEqual(['backend', 'frontend']);
  });
  it('an unknown write-set defaults to backend', () => {
    expect(inferTaskDomains(['notes.md'])).toEqual(['backend']);
  });
});

describe('WORK B — context-need inference', () => {
  it('a wide write-set (>=4 files) needs long context', () => {
    expect(inferNeedsLongContext({ writeSet: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] })).toBe(true);
  });
  it('a large/xlarge complexity needs long context', () => {
    expect(inferNeedsLongContext({ writeSet: ['a.ts'], estimated_complexity: 'large' })).toBe(true);
  });
  it('a small single-file task does not', () => {
    expect(inferNeedsLongContext({ writeSet: ['a.ts'], estimated_complexity: 'small' })).toBe(false);
  });
  it('is reproducible', () => {
    const inp = { writeSet: ['a.ts', 'b.ts'], estimated_complexity: 'medium' };
    expect(inferTaskSignals({ allowed_write_set: inp.writeSet, estimated_complexity: inp.estimated_complexity }))
      .toEqual(inferTaskSignals({ allowed_write_set: inp.writeSet, estimated_complexity: inp.estimated_complexity }));
  });
});

describe('WORK B — the composed packet carries task_signals', () => {
  it('a frontend story packet is tagged frontend', () => {
    const packet = composeDeveloperTaskPacket({
      contract: {
        story_id: 'S1', objective: 'build the settings panel', allowed_write_set: ['apps/web/src/SettingsPanel.tsx'],
        acceptance_criteria: ['renders settings'], validation_commands: ['pnpm test'], rollback_notes: 'revert',
      },
    });
    expect(packet.task_signals.domains).toEqual(['frontend']);
  });
  it('a large multi-file backend story is tagged needs_long_context', () => {
    const packet = composeDeveloperTaskPacket({
      contract: {
        story_id: 'S2', objective: 'refactor', allowed_write_set: ['packages/a/src/x.ts', 'packages/a/src/y.ts', 'packages/a/src/z.ts', 'packages/a/src/w.ts'],
        acceptance_criteria: ['works'], validation_commands: ['pnpm test'], rollback_notes: 'revert', estimated_complexity: 'large',
      },
    });
    expect(packet.task_signals.domains).toEqual(['backend']);
    expect(packet.task_signals.needs_long_context).toBe(true);
  });
});

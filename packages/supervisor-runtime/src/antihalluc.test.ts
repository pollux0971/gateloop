/**
 * Plan §1a — the Developer Task Packet always carries an explicit preserve-existing-
 * behavior directive. Previously `expected_behavior` collapsed into acceptance_criteria
 * when the contract did not enumerate behaviors, so the packet never independently told
 * the Developer to keep prior behavior intact. The directive must NOT collapse.
 */
import { describe, it, expect } from 'vitest';
import { composeDeveloperTaskPacket, BEHAVIOR_PRESERVATION_DIRECTIVE } from './index';

describe('§1a — packet always carries the preserve-existing-behavior directive', () => {
  it('directive is present and non-empty even when the contract enumerates NO expected_behavior', () => {
    const packet = composeDeveloperTaskPacket({
      contract: {
        story_id: 'S3',
        objective: 'add a stats command',
        allowed_write_set: ['tasks.mjs'],
        acceptance_criteria: ['stats_counts_total_done_pending'],
        validation_commands: ['node --test'],
        rollback_notes: 'revert tasks.mjs',
        // NOTE: no expected_behavior — the old code would collapse it to acceptance_criteria
      },
    });
    expect(packet.behavior_preservation).toEqual(BEHAVIOR_PRESERVATION_DIRECTIVE);
    expect(packet.behavior_preservation.length).toBeGreaterThan(0);
    expect(packet.behavior_preservation.join(' ')).toMatch(/Preserve ALL existing behavior/);
    expect(packet.behavior_preservation.join(' ')).toMatch(/additive at the LINE level/i);
  });

  it('the line-level additive rule is in the default forbidden_actions too', () => {
    const packet = composeDeveloperTaskPacket({
      contract: {
        story_id: 'S4', objective: 'x', allowed_write_set: ['a.mjs'],
        acceptance_criteria: ['b'], validation_commands: ['node --test'], rollback_notes: 'r',
      },
    });
    expect(packet.forbidden_actions.join(' ')).toMatch(/no removing existing behavior when modifying a shared file/);
  });

  it('does not collapse: behavior_preservation is independent of expected_behavior content', () => {
    const withBehaviors = composeDeveloperTaskPacket({
      contract: {
        story_id: 'S5', objective: 'x', allowed_write_set: ['a.mjs'],
        expected_behavior: ['does X', 'does Y'],
        acceptance_criteria: ['b'], validation_commands: ['node --test'], rollback_notes: 'r',
      },
    });
    // expected_behavior is honored AND the preservation directive is still present.
    expect(withBehaviors.task_details.expected_behavior).toEqual(['does X', 'does Y']);
    expect(withBehaviors.behavior_preservation).toEqual(BEHAVIOR_PRESERVATION_DIRECTIVE);
  });
});

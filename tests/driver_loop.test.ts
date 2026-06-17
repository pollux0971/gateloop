/**
 * STORY-029.7 — end-to-end driver loop (scripted, CI-safe).
 *
 * Proves the real cognition path runs from select to checkpoint on the scripted
 * provider, recovers an injected failure via the debug path, and calls no LLM.
 */
import { describe, it, expect } from 'vitest';
import { runDriverLoop } from '../scripts/driver-loop.ts';

describe('STORY-029.7 driver loop', () => {
  it('driver_loop_runs_select_to_checkpoint: reaches a checkpoint with final validation passed', async () => {
    const r = await runDriverLoop({ print: false });
    expect(r.reached_checkpoint).toBe(true);
    expect(r.checkpoint).not.toBeNull();
    expect(r.checkpoint!.story_id).toBe('STORY-DRIVER-LOOP');
    expect(r.checkpoint!.final_validation).toBe('passed');
    expect(r.checkpoint!.final_checkpoint_marker).toContain('CHECKPOINT REACHED');
    // the loop genuinely went through select → compose → produce → apply → validate → checkpoint
    expect(r.output).toMatch(/\[select\]/);
    expect(r.output).toMatch(/\[supervisor\] developer packet/);
    expect(r.output).toMatch(/\[developer\] producePatchProposal: OK/);
    expect(r.output).toMatch(/CHECKPOINT REACHED/);
  });

  it('injected_failure_recovers_via_debug: first validation fails, repair path makes it pass', async () => {
    const r = await runDriverLoop({ print: false });
    expect(r.checkpoint!.first_validation).toBe('failed');   // wrong patch a-b
    expect(r.checkpoint!.repaired).toBe(true);               // debug path engaged
    expect(r.checkpoint!.final_validation).toBe('passed');   // repair a+b
    expect(r.output).toMatch(/\[supervisor\] debugger packet/);
    expect(r.output).toMatch(/\[debugger\] produceRepairProposal: OK/);
    expect(r.output).toMatch(/\[validate-2\] PASS/);
  });

  it('scripted_provider_ci_safe: no real provider is used and the run is deterministic', async () => {
    const a = await runDriverLoop({ print: false });
    const b = await runDriverLoop({ print: false });
    expect(a.used_real_provider).toBe(false);
    expect(a.checkpoint!.developer_provider_kind).toBe('scripted');
    expect(a.checkpoint!.debugger_provider_kind).toBe('scripted');
    // deterministic: same checkpoint shape both runs
    expect(b.checkpoint).toEqual(a.checkpoint);
  });
});

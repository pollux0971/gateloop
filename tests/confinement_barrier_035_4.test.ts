import { describe, it, expect } from 'vitest';
import { assertToolLayerConfinementBarrier, FAKE_PLANTED_SECRET } from '@gateloop/provider-driver';
import { confinementBarrierGate, requireConfinementBeforeSpend } from '@gateloop/harness-core';

/**
 * STORY-035.4 (BARRIER): the tool-layer confinement is PROVEN effective by real probes, not
 * merely configured. This is the precondition for 035.5 (gated metered spend) — like the
 * EPIC-034 Layer-2 gate before spawning a real CLI. Zero cost: fake secret + scripted probes.
 */
describe('STORY-035.4: tool-layer confinement barrier — set ≠ effective, PROVEN', () => {
  it('all four invariants HOLD against real probes (composite barrier held)', async () => {
    const barrier = await assertToolLayerConfinementBarrier();
    const byName = Object.fromEntries(barrier.invariants.map((i) => [i.name, i]));

    expect(barrier.invariants.map((i) => i.name).sort()).toEqual([
      'default_deny_unexpected_tool_blocked_and_recorded',
      'deny_bash_truly_blocks_not_just_absent',
      'post_tool_use_redaction_removes_fake_secret_from_trace',
      'pre_tool_use_deny_actually_stops_call',
      'write_set_crux_truly_bites_reject_whole',
    ]);

    // 1. deny-Bash truly blocks — absent AND a forged call refused AND never executed
    expect(byName['deny_bash_truly_blocks_not_just_absent'].held, byName['deny_bash_truly_blocks_not_just_absent'].detail).toBe(true);
    expect(byName['deny_bash_truly_blocks_not_just_absent'].detail).toContain('executor_never_ran_bash=true');

    // 2. PreToolUse deny actually stops the call (executor not reached)
    expect(byName['pre_tool_use_deny_actually_stops_call'].held).toBe(true);
    expect(byName['pre_tool_use_deny_actually_stops_call'].detail).toContain('executor_not_reached=true');

    // 3. PostToolUse redaction removes the planted fake secret from the trace
    expect(byName['post_tool_use_redaction_removes_fake_secret_from_trace'].held).toBe(true);

    // 4. write-set crux truly bites (REJECT_WHOLE)
    expect(byName['write_set_crux_truly_bites_reject_whole'].held).toBe(true);

    // 5. default-deny: unexpected/unknown tools blocked AND recorded (covers the unforeseen)
    expect(byName['default_deny_unexpected_tool_blocked_and_recorded'].held, byName['default_deny_unexpected_tool_blocked_and_recorded'].detail).toBe(true);
    expect(byName['default_deny_unexpected_tool_blocked_and_recorded'].detail).toContain('executor_never_ran=true');

    expect(barrier.held).toBe(true);
  });

  it('the harness precondition gate opens only when the barrier is all-held (→ 035.5)', async () => {
    const barrier = await assertToolLayerConfinementBarrier();
    const gate = confinementBarrierGate(barrier);
    expect(gate.ok).toBe(true);
    expect(gate.failed).toEqual([]);
    expect(() => requireConfinementBeforeSpend(barrier)).not.toThrow();
  });

  it('NEGATIVE CONTROL: a single non-held invariant blocks the gate (the proof actually bites)', () => {
    const broken = {
      held: false,
      invariants: [
        { name: 'deny_bash_truly_blocks_not_just_absent', held: true, detail: '' },
        { name: 'post_tool_use_redaction_removes_fake_secret_from_trace', held: false, detail: 'leak!' },
      ],
    };
    const gate = confinementBarrierGate(broken);
    expect(gate.ok).toBe(false);
    expect(gate.failed).toContain('post_tool_use_redaction_removes_fake_secret_from_trace');
    expect(() => requireConfinementBeforeSpend(broken)).toThrow(/NOT HELD/);
  });

  it('an empty barrier never counts as held (fail-closed)', () => {
    expect(confinementBarrierGate({ held: true, invariants: [] }).ok).toBe(false);
  });

  it('the planted secret is an obvious fake (zero-cost proof, never a real credential)', () => {
    expect(FAKE_PLANTED_SECRET).toMatch(/FAKE/);
  });
});

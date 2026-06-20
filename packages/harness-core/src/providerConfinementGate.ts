/**
 * Confinement precondition gate (EPIC-035 / STORY-035.4 barrier → 035.5).
 *
 * The composite tool-layer confinement barrier (provider-driver's
 * assertToolLayerConfinementBarrier) must be ALL-HELD before any gated metered spend (035.5),
 * exactly as the EPIC-034 Layer-2 gate had to hold before spawning a real CLI. This is the
 * harness-side precondition check: structural input (held + the invariant list) keeps harness-core
 * decoupled from provider-driver. A non-held barrier blocks the run — the mechanism is automated,
 * but the SAFETY property (confinement proven effective) is enforced before money is spent.
 */
export interface ConfinementInvariantLike {
  name: string;
  held: boolean;
  detail: string;
}
export interface ConfinementBarrierLike {
  held: boolean;
  invariants: ConfinementInvariantLike[];
}

export interface ConfinementGateResult {
  /** True only if EVERY invariant held — the precondition for a gated metered run. */
  ok: boolean;
  reason: string;
  failed: string[];
}

/** Evaluate whether the confinement barrier permits proceeding to a gated run. */
export function confinementBarrierGate(barrier: ConfinementBarrierLike): ConfinementGateResult {
  const failed = barrier.invariants.filter((i) => !i.held).map((i) => i.name);
  const allHeld = barrier.held && failed.length === 0 && barrier.invariants.length > 0;
  return {
    ok: allHeld,
    reason: allHeld
      ? `tool-layer confinement proven effective (${barrier.invariants.length} invariants held) — precondition met`
      : `confinement NOT proven effective; gated run blocked. failed: ${failed.join(', ') || '(empty barrier)'}`,
    failed,
  };
}

/** Assert the precondition; throws if the confinement is not proven effective (fail-closed). */
export function requireConfinementBeforeSpend(barrier: ConfinementBarrierLike): void {
  const gate = confinementBarrierGate(barrier);
  if (!gate.ok) throw new Error(`CONFINEMENT BARRIER NOT HELD — refusing gated spend: ${gate.reason}`);
}

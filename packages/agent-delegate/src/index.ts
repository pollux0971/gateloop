/**
 * @gateloop/agent-delegate
 *
 * External-Agent Delegation (EPIC-033) — the seam contract + Gate-Out pipeline.
 * The driver-agnostic event/task/sandbox/driver contract (`seam-types`), the
 * delegation-result builder, and the EXIT gate that takes the agent's git diff
 * (vs the pre-delegation tree) as an UNTRUSTED patch proposal and runs it through
 * the full write-set + spec + validator + regression pipeline. The source of truth
 * is `git diff`, never the agent's self-report. `agentTrace` maps the event stream
 * onto the trace/ticker (Observe).
 *
 * The spawn-CLI driver implementation (HeadlessDriver / AcpDriver, the entry-gate
 * spawn composition, and the network-isolated delegation sandbox) was retired in
 * EPIC-035 TIER B: it was only used by the spawn-CLI path, now superseded by the
 * in-process `@gateloop/provider-driver`. The seam types it once carried were
 * extracted into `./seam-types` first, so the ProviderDriver foundation is intact.
 *
 * Design: docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md
 */

export * from './seam-types';
export * from './delegationResult';
export * from './exitGate';
export * from './agentTrace';

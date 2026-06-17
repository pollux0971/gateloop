/**
 * @gateloop/agent-delegate
 *
 * External-Agent Delegation (EPIC-033) — Headless-First, Sandbox-In, Gate-Out.
 * The external agent runs autonomously inside a disposable, network-restricted
 * sandbox; its git diff (vs the pre-delegation tree) is taken as an UNTRUSTED patch
 * proposal and passes the full write-set + spec + validator + regression + Assessor
 * pipeline. The source of truth is `git diff`, never the agent's self-report.
 *
 * Design: docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md
 */

export * from './headlessDriver';
export * from './delegationSandbox';
export * from './entryGate';
export * from './delegationResult';
export * from './exitGate';
export * from './agentTrace';

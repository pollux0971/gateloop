/**
 * @gateloop/agent-delegate — seam types (EPIC-035 TIER B extraction)
 *
 * The driver-agnostic CONTRACT surface shared across the delegation pipeline and,
 * crucially, depended on by `@gateloop/provider-driver` (the EPIC-035 metered/
 * in-process core). These are pure type declarations — no runtime, no spawn, no
 * process dependency — so the ProviderDriver seam stays intact independently of any
 * particular driver implementation.
 *
 * Extracted verbatim from `headlessDriver.ts` (STORY-033.2) so the spawn-CLI
 * implementation can be removed without disturbing this foundation. Type definitions
 * are unchanged; only their location moved.
 *
 * Design: docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md
 */

// ── CLI identity ───────────────────────────────────────────────────────────────

/** External CLI tools we can drive headless. */
export type CliKind = 'claude' | 'codex' | 'gemini';

// ── Uniform agent event ─────────────────────────────────────────────────────────

/**
 * Driver-agnostic event. Both HeadlessDriver and (later) AcpDriver emit these, so
 * the trace mapper (033.7) and the result builder (033.5) consume one shape.
 */
export type AgentEventKind =
  | 'session'      // session/init metadata (model, session id) — informational
  | 'thinking'     // reasoning / assistant text chunk
  | 'message'      // a complete assistant message
  | 'tool_call'    // the agent invoked a tool (edit, bash, read, ...)
  | 'tool_result'  // result of a tool call
  | 'diff'         // a file change the agent reported (ADVISORY — git diff is truth)
  | 'completion'   // terminal event: stop_reason + token usage
  | 'error'        // the CLI reported an error
  | 'unknown';     // a line we could not classify (kept for diagnosis, never dropped silently)

export type StopReason = 'end_turn' | 'cancelled' | 'error' | 'unknown';

export interface AgentTokens {
  input: number;
  output: number;
}

export interface AgentEvent {
  /** Which CLI produced the underlying line. */
  cli: CliKind;
  kind: AgentEventKind;
  /** Human-readable one-liner for trace/ticker; never contains secret values. */
  summary: string;
  /** Tool name when kind === 'tool_call' | 'tool_result'. */
  tool?: string;
  /** Reported file path when kind === 'diff' (advisory self-report). */
  path?: string;
  /** Terminal stop reason when kind === 'completion'. */
  stop_reason?: StopReason;
  /** Token usage; present on 'completion', sometimes on incremental events. */
  tokens?: AgentTokens;
  /** Raw parsed object, for diagnosis. The trace mapper redacts before persisting. */
  raw?: Record<string, unknown>;
}

// ── Sandbox + task packet (minimal forward-compatible shapes) ───────────────────
// STORY-033.3 hardens the sandbox and 033.4 builds the entry gate; both extend
// these. Defined minimally here so the driver compiles and is testable in isolation.

export interface DelegationTaskPacket {
  /** The instruction handed to the external agent. */
  prompt: string;
  /** Files the agent is allowed to change (enforced at the EXIT gate, not here). */
  allowed_write_set: string[];
  /** Optional path to a JSON Schema constraining the agent's structured self-report. */
  output_schema_path?: string;
  /** Optional native cost cap (USD) — defense-in-depth inner cap (Claude only today). */
  max_budget_usd?: number;
}

export interface SandboxHandle {
  /** Working directory the CLI runs in (a disposable RO-source copy in 033.3). */
  cwd: string;
  /**
   * Environment to inject into the child. Auth is passed here as an env VALUE the
   * broker provisions at launch — this module never READS a credential file. The
   * trace mapper redacts; nothing here logs env.
   */
  env?: Record<string, string>;
  /** Sandbox policy hint for CLIs that take one (Codex). */
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Optional abort signal. The entry gate (033.4) wires its wall-clock/budget kill to
   * this; the spawner forwards it to the child process so an over-limit run is killed.
   */
  signal?: AbortSignal;
}

// ── The driver interface (033.2 deliverable) ────────────────────────────────────

/**
 * One interface, two implementations (HeadlessDriver primary; AcpDriver later).
 * `run` yields an async stream of AgentEvents; completion yields control and the
 * exit gate reads the git diff from the sandbox afterwards.
 */
export interface ExternalAgentDriver {
  readonly driver: 'headless' | 'acp';
  run(packet: DelegationTaskPacket, sandbox: SandboxHandle): AsyncIterable<AgentEvent>;
}

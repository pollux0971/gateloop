/**
 * @gateloop/agent-delegate — HeadlessDriver (STORY-033.2)
 *
 * The PRIMARY external-agent driver. It spawns an external coding CLI
 * (Claude Code / Codex / Gemini) in **non-interactive (headless) mode**, reads its
 * structured JSON output (stream-json / JSON-lines), and parses each line into a
 * uniform `AgentEvent` stream so the sandbox, entry gate, and exit gate stay
 * driver-agnostic. The optional AcpDriver (STORY-033.10) emits the SAME `AgentEvent`
 * / delegation-result shapes, so nothing downstream needs to know which driver ran.
 *
 * Design: docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md
 * SPIKE  : external_references/EPIC-033_SPIKE_HEADLESS_ACP_FINDINGS.md
 *
 * ── CI-safety ────────────────────────────────────────────────────────────────
 * NO real process is ever spawned by the default code path in tests. Process
 * launch is injected via `ProcessSpawner`; tests pass a mock spawner that replays
 * recorded stdout lines. The real Node spawner (`nodeProcessSpawner`) exists for
 * production but is never exercised in CI. real_api_calls stays false throughout.
 *
 * ── Conjectured event shapes (⚠ calibrate in STORY-033.9) ────────────────────
 * The SPIKE verified every CLI's headless FLAGS and output FORMAT against the real
 * binaries (claude 2.1.178, codex 0.136.0, gemini 0.15.0) WITHOUT running a prompt
 * (no auth, no cost). The exact per-event FIELD shapes inside each stream require a
 * real run (auth + cost) and are therefore reserved for the gated E2E (033.9). The
 * parsers below encode the best-known shapes from public docs/observation and are
 * intentionally tolerant; every parser is marked `@conjecturedShape`. STORY-033.9
 * will capture real streams as fixtures and back-fill these tests against them.
 */

import { spawn } from 'node:child_process';

// ── CLI identity ───────────────────────────────────────────────────────────────

/** External CLI tools we can drive headless. */
export type CliKind = 'claude' | 'codex' | 'gemini';

export const CLI_KINDS: readonly CliKind[] = ['claude', 'codex', 'gemini'] as const;

export function isCliKind(v: unknown): v is CliKind {
  return typeof v === 'string' && (CLI_KINDS as readonly string[]).includes(v);
}

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

// ── Headless command construction (verified flags from the SPIKE) ────────────────

export interface HeadlessCommand {
  command: string;
  args: string[];
  /** Name of the env var that must carry the credential (value injected by broker). */
  auth_env_var: string;
  /** True iff the invocation is non-interactive / one-shot (always true here). */
  noninteractive: true;
}

/**
 * Build the exact non-interactive invocation for a CLI. PURE — produces a plan, does
 * not spawn anything. Flags verified against real binaries in the SPIKE.
 */
export function buildHeadlessCommand(
  cli: CliKind,
  packet: DelegationTaskPacket,
  sandbox: SandboxHandle,
): HeadlessCommand {
  switch (cli) {
    case 'claude': {
      // claude --print --bare --output-format stream-json --permission-mode bypassPermissions [prompt]
      // --bare: skip hooks/LSP/keychain; auth strictly ANTHROPIC_API_KEY. The container
      // is the real boundary, so bypassPermissions is acceptable INSIDE the sandbox.
      const args = [
        '--print',
        '--bare',
        '--output-format', 'stream-json',
        '--permission-mode', 'bypassPermissions',
      ];
      if (packet.output_schema_path) {
        // Native structured output (verified 2.1.x) — covers Claude AND Codex.
        args.push('--json-schema', packet.output_schema_path);
      }
      if (typeof packet.max_budget_usd === 'number') {
        // Native cost cap — defense-in-depth INNER cap; the entry gate (033.4) is outer.
        args.push('--max-budget-usd', String(packet.max_budget_usd));
      }
      args.push(packet.prompt);
      return { command: 'claude', args, auth_env_var: 'ANTHROPIC_API_KEY', noninteractive: true };
    }
    case 'codex': {
      // codex exec --json --ephemeral --skip-git-repo-check -s <mode> [--output-schema f] [prompt]
      const args = [
        'exec',
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s', sandbox.sandbox_mode ?? 'workspace-write',
      ];
      if (packet.output_schema_path) {
        args.push('--output-schema', packet.output_schema_path);
      }
      args.push(packet.prompt);
      // Auth: CODEX_HOME points at a broker-provisioned dir holding auth.json (never read here).
      return { command: 'codex', args, auth_env_var: 'CODEX_HOME', noninteractive: true };
    }
    case 'gemini': {
      // gemini "<prompt>" --output-format stream-json --yolo   (yolo only inside isolation)
      const args = [
        packet.prompt,
        '--output-format', 'stream-json',
        '--yolo',
      ];
      return { command: 'gemini', args, auth_env_var: 'GEMINI_API_KEY', noninteractive: true };
    }
    default: {
      const _exhaustive: never = cli;
      throw new Error(`unknown CLI kind: ${String(_exhaustive)}`);
    }
  }
}

// ── Per-CLI line parsers (⚠ @conjecturedShape — calibrate in 033.9) ──────────────

function asObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null; // non-JSON noise line (banner, progress) — not an event
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** @conjecturedShape Claude Code `--output-format stream-json` (calibrate 033.9). */
export function parseClaudeEvent(obj: Record<string, unknown>, cli: CliKind = 'claude'): AgentEvent {
  const type = str(obj['type']);
  if (type === 'system') {
    return { cli, kind: 'session', summary: `session: ${str(obj['subtype']) || 'init'}`, raw: obj };
  }
  if (type === 'result') {
    const usage = (obj['usage'] ?? {}) as Record<string, unknown>;
    const subtype = str(obj['subtype']);
    return {
      cli,
      kind: 'completion',
      summary: `completed: ${subtype || 'success'}`,
      stop_reason: subtype === 'success' || subtype === '' ? 'end_turn' : (subtype === 'cancelled' ? 'cancelled' : 'error'),
      tokens: { input: num(usage['input_tokens']), output: num(usage['output_tokens']) },
      raw: obj,
    };
  }
  if (type === 'assistant' || type === 'message') {
    const message = (obj['message'] ?? obj) as Record<string, unknown>;
    const content = message['content'];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (str(b['type']) === 'tool_use') {
            return { cli, kind: 'tool_call', tool: str(b['name']), summary: `tool: ${str(b['name'])}`, raw: obj };
          }
        }
      }
    }
    return { cli, kind: 'message', summary: 'assistant message', raw: obj };
  }
  if (type === 'tool_use') {
    return { cli, kind: 'tool_call', tool: str(obj['name']), summary: `tool: ${str(obj['name'])}`, raw: obj };
  }
  if (type === 'error') {
    return { cli, kind: 'error', summary: `error: ${str(obj['message']) || 'unknown'}`, raw: obj };
  }
  return { cli, kind: 'unknown', summary: `unclassified claude line (type=${type || '∅'})`, raw: obj };
}

/** @conjecturedShape Codex `exec --json` JSONL events (calibrate 033.9). */
export function parseCodexEvent(obj: Record<string, unknown>, cli: CliKind = 'codex'): AgentEvent {
  // Codex wraps events under `msg` (older) or top-level `type` (newer item.* events).
  const msg = (obj['msg'] && typeof obj['msg'] === 'object') ? (obj['msg'] as Record<string, unknown>) : obj;
  const type = str(msg['type']) || str(obj['type']);
  if (type === 'agent_message' || type === 'item.completed' || type === 'message') {
    const text = str(msg['message']) || str(msg['text']);
    return { cli, kind: 'message', summary: text ? `message: ${text.slice(0, 80)}` : 'agent message', raw: obj };
  }
  if (type === 'agent_reasoning' || type === 'reasoning' || type === 'thinking') {
    return { cli, kind: 'thinking', summary: 'reasoning', raw: obj };
  }
  if (type.includes('exec_command') || type.includes('tool') || type === 'function_call') {
    const tool = str(msg['command']) || str(msg['name']) || 'tool';
    return { cli, kind: 'tool_call', tool, summary: `tool: ${tool}`, raw: obj };
  }
  if (type === 'patch_apply' || type === 'apply_patch' || type.includes('file_change')) {
    return { cli, kind: 'diff', path: str(msg['path']), summary: `diff: ${str(msg['path']) || 'patch'}`, raw: obj };
  }
  if (type === 'task_complete' || type === 'turn_complete' || type === 'completion') {
    const usage = (msg['usage'] ?? obj['usage'] ?? {}) as Record<string, unknown>;
    return {
      cli,
      kind: 'completion',
      summary: 'completed',
      stop_reason: 'end_turn',
      tokens: { input: num(usage['input_tokens']), output: num(usage['output_tokens']) },
      raw: obj,
    };
  }
  if (type === 'error') {
    return { cli, kind: 'error', summary: `error: ${str(msg['message']) || 'unknown'}`, raw: obj };
  }
  return { cli, kind: 'unknown', summary: `unclassified codex line (type=${type || '∅'})`, raw: obj };
}

/** @conjecturedShape Gemini `--output-format stream-json` (calibrate 033.9). */
export function parseGeminiEvent(obj: Record<string, unknown>, cli: CliKind = 'gemini'): AgentEvent {
  const type = str(obj['type']);
  if (type === 'thought' || type === 'thinking') {
    return { cli, kind: 'thinking', summary: 'thought', raw: obj };
  }
  if (type === 'content' || type === 'text' || type === 'assistant') {
    return { cli, kind: 'message', summary: 'assistant content', raw: obj };
  }
  if (type === 'tool_call' || type === 'tool_code' || type === 'function_call') {
    const tool = str(obj['name']) || str((obj['tool'] as Record<string, unknown> | undefined)?.['name']) || 'tool';
    return { cli, kind: 'tool_call', tool, summary: `tool: ${tool}`, raw: obj };
  }
  if (type === 'tool_result' || type === 'function_response') {
    return { cli, kind: 'tool_result', tool: str(obj['name']), summary: 'tool result', raw: obj };
  }
  if (type === 'result' || type === 'response' || type === 'completion' || type === 'finish') {
    const stats = (obj['stats'] ?? obj['usage'] ?? {}) as Record<string, unknown>;
    return {
      cli,
      kind: 'completion',
      summary: 'completed',
      stop_reason: 'end_turn',
      tokens: { input: num(stats['input_tokens']) || num(stats['promptTokenCount']), output: num(stats['output_tokens']) || num(stats['candidatesTokenCount']) },
      raw: obj,
    };
  }
  if (type === 'error') {
    return { cli, kind: 'error', summary: `error: ${str(obj['message']) || 'unknown'}`, raw: obj };
  }
  return { cli, kind: 'unknown', summary: `unclassified gemini line (type=${type || '∅'})`, raw: obj };
}

/** Dispatch one raw stdout line to the right CLI parser. Returns null for noise. */
export function parseHeadlessLine(cli: CliKind, line: string): AgentEvent | null {
  const obj = asObject(line);
  if (!obj) return null;
  switch (cli) {
    case 'claude': return parseClaudeEvent(obj, cli);
    case 'codex': return parseCodexEvent(obj, cli);
    case 'gemini': return parseGeminiEvent(obj, cli);
    default: {
      const _exhaustive: never = cli;
      throw new Error(`unknown CLI kind: ${String(_exhaustive)}`);
    }
  }
}

// ── Process spawner abstraction (the CI-safety seam) ─────────────────────────────

export interface SpawnedProcess {
  /** stdout decoded into lines, yielded as they arrive. */
  lines: AsyncIterable<string>;
  /** Resolves with the process exit code once stdout closes. */
  exitCode: Promise<number>;
}

export type ProcessSpawner = (
  command: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; signal?: AbortSignal },
) => SpawnedProcess;

/**
 * Mock spawner: replays recorded stdout lines, never touching the OS. The backbone
 * of CI-safe tests. `delayMs` is ignored (kept for signature parity / future use).
 */
export function mockProcessSpawner(lines: string[], exitCode = 0): ProcessSpawner {
  return () => ({
    lines: (async function* () {
      for (const l of lines) yield l;
    })(),
    exitCode: Promise.resolve(exitCode),
  });
}

// ── HeadlessDriver ───────────────────────────────────────────────────────────────

export interface HeadlessDriverOptions {
  cli: CliKind;
  /** Injected spawner. Defaults to the real Node spawner (never used in CI tests). */
  spawner?: ProcessSpawner;
}

export class HeadlessDriver implements ExternalAgentDriver {
  readonly driver = 'headless' as const;
  readonly cli: CliKind;
  private readonly spawner: ProcessSpawner;

  constructor(opts: HeadlessDriverOptions) {
    this.cli = opts.cli;
    this.spawner = opts.spawner ?? nodeProcessSpawner;
  }

  /** The non-interactive plan the driver WOULD spawn (pure — for inspection/tests). */
  plan(packet: DelegationTaskPacket, sandbox: SandboxHandle): HeadlessCommand {
    return buildHeadlessCommand(this.cli, packet, sandbox);
  }

  async *run(packet: DelegationTaskPacket, sandbox: SandboxHandle): AsyncIterable<AgentEvent> {
    const cmd = buildHeadlessCommand(this.cli, packet, sandbox);
    const proc = this.spawner(cmd.command, cmd.args, { env: sandbox.env, cwd: sandbox.cwd, signal: sandbox.signal });
    let sawCompletion = false;
    for await (const line of proc.lines) {
      const ev = parseHeadlessLine(this.cli, line);
      if (!ev) continue;
      if (ev.kind === 'completion') sawCompletion = true;
      yield ev;
    }
    const code = await proc.exitCode;
    // If the CLI never emitted a terminal event, synthesize one from the exit code so
    // the exit gate always receives exactly one completion.
    if (!sawCompletion) {
      yield {
        cli: this.cli,
        kind: 'completion',
        summary: code === 0 ? 'completed (synthesized: clean exit)' : `completed (synthesized: exit ${code})`,
        stop_reason: code === 0 ? 'end_turn' : 'error',
        tokens: { input: 0, output: 0 },
        raw: { synthesized: true, exit_code: code },
      };
    }
  }
}

/** Collect a run's events into an array (convenience for non-streaming callers/tests). */
export async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// ── Real Node spawner (production path; never invoked in CI) ──────────────────────

/**
 * Production spawner backed by node:child_process. Imported lazily so the package
 * carries no eager dependency on a process API in test/bundler contexts. This path
 * is intentionally NOT exercised by the CI test suite (real_api_calls stays false).
 */
export const nodeProcessSpawner: ProcessSpawner = (command, args, opts) => {
  // Importing child_process is side-effect-free; CI-safety is that this function is
  // never CALLED in tests (the mock spawner is injected instead).
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: opts.signal,
  });

  const lines = (async function* () {
    let buf = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length) yield line;
      }
    }
    if (buf.trim().length) yield buf;
  })();

  const exitCode = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(-1));
  });

  return { lines, exitCode };
};

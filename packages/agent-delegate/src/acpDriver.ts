/**
 * @gateloop/agent-delegate — AcpDriver (STORY-033.10, scriptable parts).
 *
 * The secondary driver: same ExternalAgentDriver interface as HeadlessDriver, same
 * AgentEvent stream, same DelegationResult contract, same entry/exit gates. Only the
 * transport differs — ACP (Agent Client Protocol) instead of a headless stdout stream.
 *
 * SCOPE (plan §5.2 scriptable): the interface implementation, ACP-message→AgentEvent
 * translation, and registry selectability — all provable with an injected mock
 * transport at zero cost. The REAL ACP wire (gemini --experimental-acp JSON-RPC
 * connection) is GATED and intentionally NOT implemented here: there is no default
 * real transport, so an acp run requires a transport injected at launch.
 */
import {
  HeadlessDriver,
  type ProcessSpawner,
} from './headlessDriver';
import type {
  AgentEvent, AgentEventKind, CliKind, StopReason,
  DelegationTaskPacket, SandboxHandle, ExternalAgentDriver,
} from './seam-types';

/** A parsed ACP protocol message (post JSON-RPC decode). The real transport produces
 *  these from the wire; tests inject them directly. */
export interface AcpMessage {
  method: string;
  params?: Record<string, unknown>;
}

/** An open ACP connection: a stream of messages + a terminal exit code. */
export interface AcpConnection {
  messages: AsyncIterable<AcpMessage>;
  done: Promise<number>;
}

/** Injected transport (the ACP analogue of ProcessSpawner). The real implementation
 *  speaks gemini --experimental-acp and is wired only at launch under the gate; CI
 *  injects a mock. There is deliberately NO default real transport in this module. */
export type AcpTransport = (packet: DelegationTaskPacket, sandbox: SandboxHandle) => AcpConnection;

/** Map an ACP method to the uniform AgentEvent kind (unknown is KEPT, never dropped). */
function acpKind(method: string): AgentEventKind {
  switch (method) {
    case 'session/new': case 'session/update': case 'session/init': return 'session';
    case 'session/thought': case 'agent_thought_chunk': return 'thinking';
    case 'agent_message': case 'agent_message_chunk': return 'message';
    case 'tool_call': case 'session/request_tool': return 'tool_call';
    case 'tool_result': case 'session/tool_result': return 'tool_result';
    case 'fs/write_text_file': case 'diff': return 'diff';
    case 'session/complete': case 'session/end': return 'completion';
    case 'error': case 'session/error': return 'error';
    default: return 'unknown';
  }
}

/** Translate one ACP message into the driver-agnostic AgentEvent. */
export function parseAcpMessage(cli: CliKind, msg: AcpMessage): AgentEvent {
  const kind = acpKind(msg.method);
  const p = msg.params ?? {};
  const ev: AgentEvent = { cli, kind, summary: '', raw: { method: msg.method, ...p } };
  switch (kind) {
    case 'tool_call':
    case 'tool_result':
      ev.tool = typeof p.tool === 'string' ? p.tool : (typeof p.name === 'string' ? p.name : 'unknown');
      ev.summary = `${kind === 'tool_call' ? 'tool' : 'tool result'}: ${ev.tool}`;
      break;
    case 'diff':
      ev.path = typeof p.path === 'string' ? p.path : undefined;
      ev.summary = `diff (advisory): ${ev.path ?? '<unknown path>'}`;
      break;
    case 'completion': {
      ev.stop_reason = (typeof p.stop_reason === 'string' ? p.stop_reason : 'end_turn') as StopReason;
      const t = (p.tokens ?? {}) as { input?: number; output?: number };
      ev.tokens = { input: t.input ?? 0, output: t.output ?? 0 };
      ev.summary = `completed (${ev.stop_reason})`;
      break;
    }
    case 'thinking':
    case 'message':
      ev.summary = typeof p.text === 'string' ? p.text.slice(0, 200) : kind;
      break;
    case 'error':
      ev.summary = typeof p.message === 'string' ? p.message : 'acp error';
      break;
    default:
      ev.summary = `acp:${msg.method}`;
  }
  return ev;
}

export interface AcpDriverOptions {
  /** Per the SPIKE, Gemini is the only native-ACP CLI; default 'gemini'. */
  cli?: CliKind;
  /** REQUIRED transport. No real default (the real ACP wire is gated). */
  transport: AcpTransport;
}

export class AcpDriver implements ExternalAgentDriver {
  readonly driver = 'acp' as const;
  readonly cli: CliKind;
  private readonly transport: AcpTransport;
  constructor(opts: AcpDriverOptions) {
    this.cli = opts.cli ?? 'gemini';
    this.transport = opts.transport;
  }

  async *run(packet: DelegationTaskPacket, sandbox: SandboxHandle): AsyncIterable<AgentEvent> {
    const conn = this.transport(packet, sandbox);
    let sawCompletion = false;
    for await (const msg of conn.messages) {
      const ev = parseAcpMessage(this.cli, msg);
      if (ev.kind === 'completion') sawCompletion = true;
      yield ev;
    }
    const code = await conn.done;
    // Same invariant as HeadlessDriver: the exit gate always receives exactly one
    // completion — synthesize from the exit code if the wire never sent one.
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

// ── Driver registry / selection (STORY-033.10: driver_acp_selectable_in_registry) ──

export type DriverKind = 'headless' | 'acp';

export interface DriverSelectOptions {
  cli?: CliKind;
  /** Headless transport (real spawner injected at launch; mock in CI). */
  spawner?: ProcessSpawner;
  /** ACP transport — REQUIRED for kind='acp' (the real wire is gated). */
  transport?: AcpTransport;
}

/**
 * Select a driver by kind. Both share the ExternalAgentDriver interface and the
 * downstream result contract + gates, so the rest of the pipeline is driver-agnostic.
 * Choosing 'acp' without a transport throws — the real ACP connection is gated.
 */
export function selectDriver(kind: DriverKind, opts: DriverSelectOptions = {}): ExternalAgentDriver {
  if (kind === 'acp') {
    if (!opts.transport) {
      throw new Error('acp driver requires a transport; the real Gemini ACP wire is gated and injected at launch');
    }
    return new AcpDriver({ cli: opts.cli ?? 'gemini', transport: opts.transport });
  }
  return new HeadlessDriver({ cli: opts.cli ?? 'claude', spawner: opts.spawner });
}

/**
 * ProviderDriver (EPIC-035 / STORY-035.2) — drives a backend IN-PROCESS and yields the harness's
 * `AgentEvent` stream, behind the same seam the HeadlessDriver/AcpDriver sit behind.
 *
 * The core sees only `run(packet, sandbox): AsyncIterable<AgentEvent>` (the inherited driver
 * shape); the Vercel AI SDK lives entirely inside the injected `LanguageModelEngine` (engine.ts /
 * aiSdkEngine.ts) and never crosses into core. Tool calls are OPTIONALLY mediated by an injected
 * `ProviderToolMediator` — 035.3 supplies the real MCP-only + permission-gateway + hooks mediator;
 * 035.2 runs with a scripted engine + optional simple mediator, zero provider spend.
 */
import type { AgentEvent, DelegationTaskPacket, SandboxHandle } from '@gateloop/agent-delegate';
import type { LanguageModelEngine, EngineTool } from './engine';
import { mapEnginePartToAgentEvent, backendToCliKind } from './aiSdkAdapter';

/** Same run shape as `ExternalAgentDriver.run` — the core consumes drivers only through this. */
export interface ProviderRunner {
  readonly driver: string;
  readonly backendId: string;
  run(packet: DelegationTaskPacket, sandbox: SandboxHandle): AsyncIterable<AgentEvent>;
}

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type ToolMediation =
  | { allowed: true; output: unknown }
  | { allowed: false; reason: string };

/** Verdict of the Stop hook (035.3: require a report before the agent may stop). */
export interface StopVerdict {
  ok: boolean;
  reason?: string;
}

/** The harness's mediation of a tool call (035.3: MCP-only + permission gateway + hooks). */
export interface ProviderToolMediator {
  /** The tool surface offered to the model (035.3: high-level MCP tools, Bash absent). */
  tools(): EngineTool[];
  mediate(call: ToolCall): Promise<ToolMediation> | ToolMediation;
  /** Stop hook — called by the driver after the stream ends (035.3: require a report). */
  onStop?(): StopVerdict | Promise<StopVerdict>;
}

export interface ProviderDriverOptions {
  engine: LanguageModelEngine;
  /** Optional tool mediator; when present, tool-calls are executed by the harness (not the SDK). */
  toolMediator?: ProviderToolMediator;
  /** Redactor (e.g. broker.redact) applied to every event summary. */
  redact?: (s: string) => string;
  system?: string;
}

export class ProviderDriver implements ProviderRunner {
  readonly driver = 'provider';
  readonly backendId: string;
  private readonly opts: ProviderDriverOptions;

  constructor(opts: ProviderDriverOptions) {
    this.opts = opts;
    this.backendId = opts.engine.backendId;
  }

  async *run(packet: DelegationTaskPacket, sandbox: SandboxHandle): AsyncIterable<AgentEvent> {
    const { engine, toolMediator, redact } = this.opts;
    const cli = backendToCliKind(this.backendId);

    yield {
      cli,
      kind: 'session',
      summary: `session:${this.backendId}/${engine.model}`,
      raw: { backendId: this.backendId, model: engine.model },
    };

    const tools = toolMediator?.tools();
    const handled = new Set<string>();

    for await (const part of engine.stream({
      prompt: packet.prompt,
      system: this.opts.system,
      tools,
      signal: sandbox.signal,
    })) {
      // Harness-mediated tool calls: emit the call, then execute via the mediator (which may
      // DENY — that is 035.3's permission gateway). Skip any engine-supplied result for it.
      if (part.type === 'tool-call' && toolMediator) {
        const callEv = mapEnginePartToAgentEvent(this.backendId, part, redact);
        if (callEv) yield callEv;
        handled.add(part.toolCallId);
        const verdict = await toolMediator.mediate({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        if (verdict.allowed) {
          yield mapEnginePartToAgentEvent(this.backendId, {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: verdict.output,
          }, redact)!;
        } else {
          yield {
            cli,
            kind: 'tool_result',
            tool: part.toolName,
            summary: redact ? redact(`tool_denied:${part.toolName} ${verdict.reason}`) : `tool_denied:${part.toolName} ${verdict.reason}`,
            raw: { backendId: this.backendId, denied: true, reason: verdict.reason, toolName: part.toolName },
          };
        }
        continue;
      }
      if (part.type === 'tool-result' && handled.has(part.toolCallId)) continue;

      const ev = mapEnginePartToAgentEvent(this.backendId, part, redact);
      if (ev) yield ev;
    }

    // Stop hook (035.3): require a report before the agent may stop. A missing report does not
    // crash the run — it is surfaced as an observable event so the exit gate / operator sees it.
    if (toolMediator?.onStop) {
      const verdict = await toolMediator.onStop();
      if (!verdict.ok) {
        yield {
          cli,
          kind: 'error',
          summary: redact ? redact(`stop_blocked: ${verdict.reason ?? 'report required'}`) : `stop_blocked: ${verdict.reason ?? 'report required'}`,
          raw: { backendId: this.backendId, stop_blocked: true, reason: verdict.reason },
        };
      }
    }
  }
}

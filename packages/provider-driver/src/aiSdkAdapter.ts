/**
 * Map neutral engine parts → the harness's `AgentEvent` (EPIC-035 / STORY-035.2).
 *
 * The same `AgentEvent` shape the HeadlessDriver/AcpDriver emit, so the trace mapper, ticker,
 * cockpit, and result builder consume ONE shape regardless of how the diff was produced. Pure
 * and deterministic — unit-tested without any provider call.
 */
import type { AgentEvent, CliKind, StopReason } from '@gateloop/agent-delegate';
import type { EngineStreamPart } from './engine';

/**
 * `AgentEvent.cli` is the inherited `CliKind` union ('claude'|'codex'|'gemini'); we cannot
 * widen it from this package (agent-delegate is out of this story's write-set), so concrete
 * metered backends are mapped onto the nearest kind, and the exact backend id is preserved
 * in `raw.backendId` for fidelity. (035.7 may broaden the union to a backend id.)
 */
export function backendToCliKind(backendId: string): CliKind {
  switch (backendId) {
    case 'anthropic':
    case 'claude':
      return 'claude';
    case 'gemini':
    case 'google':
      return 'gemini';
    default:
      // openai / codex / any other metered backend ride the 'codex' (OpenAI-family) lane.
      return 'codex';
  }
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'end_turn';
    case 'tool-calls':
    case 'length':
      return 'unknown';
    case 'error':
      return 'error';
    case 'abort':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

const truncate = (s: string, n = 200): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** Deep-apply the redactor to every string in a value — so a resolved secret never survives in
 *  `raw` either (defense-in-depth: the event carries no plaintext anywhere, not just in summary). */
function redactValue(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, redact);
    return out;
  }
  return value;
}

/**
 * Map one engine part to an AgentEvent, applying `redact` to every human-readable summary
 * (the broker's redactor — a resolved key must never reach a trace). Returns null for parts
 * that carry no observable event (none today; kept for forward-compatible part kinds).
 */
export function mapEnginePartToAgentEvent(
  backendId: string,
  part: EngineStreamPart,
  redact: (s: string) => string = (s) => s,
): AgentEvent | null {
  const cli = backendToCliKind(backendId);
  const rawObj = redactValue({ backendId, ...(part as Record<string, unknown>) }, redact) as Record<string, unknown>;
  const base = { cli, raw: rawObj } as const;
  switch (part.type) {
    case 'text-delta':
      return { ...base, kind: 'message', summary: redact(truncate(part.text)) };
    case 'reasoning-delta':
      return { ...base, kind: 'thinking', summary: redact(truncate(part.text)) };
    case 'tool-call':
      return {
        ...base,
        kind: 'tool_call',
        tool: part.toolName,
        summary: redact(`tool_call:${part.toolName} ${truncate(JSON.stringify(part.input ?? {}), 120)}`),
      };
    case 'tool-result':
      return {
        ...base,
        kind: 'tool_result',
        tool: part.toolName,
        summary: redact(`tool_result:${part.toolName} ${truncate(JSON.stringify(part.output ?? {}), 120)}`),
      };
    case 'finish':
      return {
        ...base,
        kind: 'completion',
        summary: `completion:${part.finishReason}`,
        stop_reason: mapFinishReason(part.finishReason),
        tokens: { input: part.usage.inputTokens, output: part.usage.outputTokens },
      };
    case 'error':
      return { ...base, kind: 'error', summary: redact(truncate(String((part.error as Error)?.message ?? part.error))) };
    default: {
      const _exhaustive: never = part;
      void _exhaustive;
      return null;
    }
  }
}

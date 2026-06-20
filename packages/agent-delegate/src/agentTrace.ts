/**
 * @gateloop/agent-delegate — AgentEvent → trace + thinking ticker (STORY-033.7)
 *
 * Observability for "sandbox-in": the HeadlessDriver's AgentEvent stream is mapped
 * onto the existing append-only trace and the v5 thinking ticker, so the operator can
 * watch what the external agent is doing inside the sandbox. The AcpDriver (033.10)
 * reuses this same mapping.
 *
 * Secret-safety: every string that reaches the trace/ticker is run through the
 * event-log redactor; the raw CLI object is NEVER placed in the trace (it stays
 * in-memory for local diagnosis only). So no secret value can enter the trace.
 *
 * Design: docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md
 */

import { redact } from '@gateloop/event-log';
import type { AgentEvent } from './seam-types';

/** A trace-event input (the harness owns event-log; this stays dependency-light). */
export interface AgentTraceInput {
  type: string;
  agent_role: string;
  summary: string;
  payload: Record<string, unknown>;
}

/** Trace `type` for each AgentEvent kind. Namespaced so delegation events are filterable. */
function traceType(ev: AgentEvent): string {
  return `delegate_${ev.kind}`;
}

/**
 * Map one AgentEvent into a redacted trace input. The raw CLI object is intentionally
 * excluded; only structured, redacted fields reach the trace. agent_role identifies
 * the external CLI (`external:claude` etc.) so the trace shows it came from a sandbox.
 */
export function mapAgentEventToTrace(ev: AgentEvent): AgentTraceInput {
  const payload: Record<string, unknown> = {
    cli: ev.cli,
    kind: ev.kind,
  };
  if (ev.tool !== undefined) payload.tool = ev.tool;
  if (ev.path !== undefined) payload.path = ev.path;
  if (ev.stop_reason !== undefined) payload.stop_reason = ev.stop_reason;
  if (ev.tokens !== undefined) payload.tokens = ev.tokens;
  return {
    type: traceType(ev),
    agent_role: `external:${ev.cli}`,
    // redact() strips secret-looking strings before anything is recorded.
    summary: redact(ev.summary),
    payload: redact(payload),
  };
}

// ── Thinking ticker projection ───────────────────────────────────────────────────

export interface DelegationTickerItem {
  eventId: string;
  /** Collapsed preview (one line). Redacted. */
  preview: string;
  /** Expanded full text. Redacted. */
  fullText: string;
  /** `external:<cli>` so the ticker shows the sandbox agent. */
  agentRole: string;
  kind: AgentEvent['kind'];
}

const KIND_GLYPH: Record<AgentEvent['kind'], string> = {
  session: '◆',
  thinking: '…',
  message: '✎',
  tool_call: '⚙',
  tool_result: '↩',
  diff: '±',
  completion: '✔',
  error: '✗',
  unknown: '·',
};

/**
 * Project an AgentEvent onto a v5 thinking-ticker item (consumed by the web
 * ReasoningEvent component). Redacted; never carries the raw CLI object.
 */
export function agentEventToTicker(ev: AgentEvent, index: number): DelegationTickerItem {
  const glyph = KIND_GLYPH[ev.kind] ?? '·';
  const head = redact(ev.summary);
  const detailParts = [
    `kind: ${ev.kind}`,
    ev.tool ? `tool: ${redact(ev.tool)}` : '',
    ev.path ? `path: ${redact(ev.path)}` : '',
    ev.stop_reason ? `stop: ${ev.stop_reason}` : '',
    ev.tokens ? `tokens: in=${ev.tokens.input} out=${ev.tokens.output}` : '',
  ].filter(Boolean);
  return {
    eventId: `delegate-${ev.cli}-${index}`,
    preview: `${glyph} ${head}`,
    fullText: [`${glyph} ${head}`, ...detailParts].join('\n'),
    agentRole: `external:${ev.cli}`,
    kind: ev.kind,
  };
}

/** Map a whole AgentEvent stream to ticker items (for the operator's live view). */
export function agentEventsToTicker(events: AgentEvent[]): DelegationTickerItem[] {
  return events.map((ev, i) => agentEventToTicker(ev, i));
}

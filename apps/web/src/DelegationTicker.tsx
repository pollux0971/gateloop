import { agentEventsToTicker, type AgentEvent, type DelegationTickerItem } from '@gateloop/agent-delegate';
import { ReasoningEvent } from './ReasoningEvent';

/**
 * STORY-033.7 — live view of what the external agent is doing inside the sandbox.
 * The HeadlessDriver's AgentEvent stream is projected onto the v5 thinking ticker
 * (ReasoningEvent) so the operator can OBSERVE sandbox activity. All text is already
 * redacted by the agent-delegate mapper — no secret reaches the UI.
 */

const mono = { fontFamily: 'JetBrains Mono, ui-monospace, monospace' } as const;

export interface DelegationTickerProps {
  /** Either raw AgentEvents (mapped here) or pre-mapped ticker items. */
  events?: AgentEvent[];
  items?: DelegationTickerItem[];
  cli?: string;
}

export function DelegationTicker({ events, items, cli }: DelegationTickerProps): JSX.Element {
  const resolved: DelegationTickerItem[] = items ?? (events ? agentEventsToTicker(events) : []);

  return (
    <div data-testid="delegation-ticker" data-cli={cli}>
      <div style={{ ...mono, fontSize: 10, color: '#5BD6C0', marginBottom: 6 }}>
        sandbox agent activity{cli ? ` · ${cli}` : ''}
      </div>
      {resolved.length === 0 ? (
        <div style={{ ...mono, fontSize: 11, color: 'rgba(230,237,243,.34)' }}>— no sandbox activity —</div>
      ) : (
        resolved.map((it) => (
          <ReasoningEvent
            key={it.eventId}
            eventId={it.eventId}
            preview={it.preview}
            fullText={it.fullText}
            agentRole={it.agentRole}
          />
        ))
      )}
    </div>
  );
}

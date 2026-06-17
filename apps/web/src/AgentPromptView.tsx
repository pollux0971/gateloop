import { useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * STORY-032.5 — Agent full system-prompt view.
 *
 * Renders each agent's CONFIG-LEVEL composed system prompt, read from the
 * introspection endpoint GET /agents/{role}/prompt (032.4). This is a STATIC
 * asset view — what the agent should look like given its configuration — NOT a
 * runtime execution snapshot. Its purpose: diagnose a bad output as prompt/skill
 * authoring vs model capability, by reading the asset directly.
 */

const mono: CSSProperties = { fontFamily: 'JetBrains Mono, ui-monospace, monospace' };
const card: CSSProperties = { background: '#18242F', border: '1px solid rgba(230,237,243,.1)', borderRadius: 9, padding: 12, marginBottom: 10 };
const dim: CSSProperties = { color: 'rgba(230,237,243,.34)' };

export interface AgentPromptData {
  role: string;
  base: string;
  mounted_skills: { name: string; summary?: string }[];
  envelope_docs: string;
  composed: string;
  /** Always true — config-level, not a runtime execution. */
  static_config_level: true;
}

export interface AgentPromptViewProps {
  /** One entry per agent role, from GET /agents/{role}/prompt. */
  views: AgentPromptData[];
}

function StaticBadge(): JSX.Element {
  return (
    <span
      data-testid="static-not-runtime"
      style={{ ...mono, fontSize: 10, color: '#F2A65A', background: '#F2A65A22', borderRadius: 4, padding: '1px 6px' }}
    >
      static · config-level · not a runtime execution
    </span>
  );
}

function AgentCard({ view }: { view: AgentPromptData }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div data-agent-role={view.role} data-source="GET /agents/{role}/prompt" style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{ ...mono, fontSize: 13, fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', color: '#E6EDF3', padding: 0 }}
        >
          {open ? '▾' : '▸'} {view.role}
        </button>
        <span style={{ ...mono, fontSize: 10, ...dim }}>{view.mounted_skills.length} skills mounted</span>
        <StaticBadge />
      </div>
      {open && (
        <div>
          <div style={{ ...mono, fontSize: 10, textTransform: 'uppercase', ...dim, margin: '6px 0 2px' }}>composed system prompt</div>
          <pre data-testid={`composed-${view.role}`} style={{ ...mono, fontSize: 11.5, whiteSpace: 'pre-wrap', background: '#0D1117', borderRadius: 6, padding: 10, margin: 0 }}>
            {view.composed}
          </pre>
        </div>
      )}
    </div>
  );
}

export function AgentPromptView({ views }: AgentPromptViewProps): JSX.Element {
  return (
    <div data-testid="agent-prompt-view-static" style={{ padding: 16, color: '#E6EDF3', background: '#0D1117' }}>
      <div style={{ ...mono, fontSize: 10, textTransform: 'uppercase', color: 'rgba(230,237,243,.56)', marginBottom: 6 }}>
        Agent system prompts
      </div>
      <div style={{ fontSize: 11.5, ...dim, marginBottom: 12 }}>
        Read from <code style={mono}>GET /agents/&#123;role&#125;/prompt</code> — the configured composition, not a runtime trace.
      </div>
      {views.map(v => <AgentCard key={v.role} view={v} />)}
    </div>
  );
}

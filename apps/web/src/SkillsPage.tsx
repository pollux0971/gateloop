import { useState } from 'react';
import type { CSSProperties } from 'react';

const mono: CSSProperties = { fontFamily: 'JetBrains Mono, ui-monospace, monospace' };
const card: CSSProperties = { background: '#18242F', border: '1px solid rgba(230,237,243,.1)', borderRadius: 9, padding: 12, marginBottom: 10 };
const dim: CSSProperties = { color: 'rgba(230,237,243,.34)' };

/** STORY-032.5: a skill's full contents, from GET /skills/{id} (032.4). Static asset. */
export interface SkillScriptSource {
  name: string;
  source: string;
}
export interface SkillDetail {
  id: string;
  metadata: Record<string, unknown>;
  skill_md: string;
  scripts: SkillScriptSource[];
  /** Always true — static asset, not a runtime execution. */
  static_config_level: true;
}

export interface SkillEntry {
  skill_id: string;
  agent_role: string;
  description: string;
  status: 'registered' | 'quarantined' | 'needs_tests' | 'draft';
  avoid_lines?: string[];
  test_count?: number;
  quarantine_reason?: string;
  /** STORY-032.5: full contents (metadata + SKILL.md + scripts) from GET /skills/{id}. */
  detail?: SkillDetail;
  /** STORY-GATE.4/5: user on/off toggle (default true) + shipped-by-default builtin. */
  enabled?: boolean;
  builtin?: boolean;
}

/** STORY-GATE.5: a cockpit skill-control request — the server enforces the §4d boundary. */
export interface SkillControlRequest { op: 'toggle' | 'delete'; skill_id: string; enabled?: boolean }

export interface ToolAllowlistEntry {
  role: string;
  allowed_tools: string[];
}

export interface SkillsPageProps {
  skills: SkillEntry[];
  toolAllowlist?: ToolAllowlistEntry[];
  /** STORY-GATE.5: skill-control callback (toggle/delete). Injected for tests; defaults to
   *  a fetch to the server, which enforces the §4d boundary — the UI is NOT the enforcer. */
  onSkillControl?: (req: SkillControlRequest) => void;
}

/** Default control: hit the server endpoints. The SERVER (not this fetch) enforces §4d. */
function defaultSkillControl(req: SkillControlRequest): void {
  if (req.op === 'toggle') {
    void fetch(`/api/skills/${encodeURIComponent(req.skill_id)}/enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: req.enabled }),
    });
  } else {
    void fetch(`/api/skills/${encodeURIComponent(req.skill_id)}`, { method: 'DELETE' });
  }
}

const STATUS_COLOR: Record<SkillEntry['status'], string> = {
  registered:   '#7EE081',
  quarantined:  '#E57373',
  needs_tests:  '#F2A65A',
  draft:        'rgba(230,237,243,.34)',
};

function SkillContents({ detail }: { detail: SkillDetail }): JSX.Element {
  const [tab, setTab] = useState<'metadata' | 'markdown' | 'scripts'>('metadata');
  const tabBtn = (id: 'metadata' | 'markdown' | 'scripts', label: string): JSX.Element => (
    <button
      onClick={() => setTab(id)}
      data-tab={id}
      style={{ ...mono, fontSize: 10, background: tab === id ? '#26323D' : 'none', border: '1px solid rgba(230,237,243,.1)', borderRadius: 4, color: '#E6EDF3', cursor: 'pointer', padding: '2px 8px', marginRight: 4 }}
    >
      {label}
    </button>
  );
  const pre: CSSProperties = { ...mono, fontSize: 11, whiteSpace: 'pre-wrap', background: '#0D1117', borderRadius: 6, padding: 8, margin: '6px 0 0', maxHeight: 240, overflow: 'auto' };
  return (
    <div data-testid="skill-contents" data-source="GET /skills/{id}" style={{ marginTop: 6 }}>
      <div>{tabBtn('metadata', 'metadata')}{tabBtn('markdown', 'SKILL.md')}{tabBtn('scripts', `scripts (${detail.scripts.length})`)}</div>
      {tab === 'metadata' && <pre data-testid="tab-metadata" style={pre}>{JSON.stringify(detail.metadata, null, 2)}</pre>}
      {tab === 'markdown' && <pre data-testid="tab-markdown" style={pre}>{detail.skill_md}</pre>}
      {tab === 'scripts' && (
        <div data-testid="tab-scripts">
          {detail.scripts.length === 0 && <div style={{ ...mono, fontSize: 11, ...dim, marginTop: 6 }}>no scripts</div>}
          {detail.scripts.map(s => (
            <div key={s.name}>
              <div style={{ ...mono, fontSize: 10, ...dim, marginTop: 6 }}>{s.name}</div>
              <pre style={pre}>{s.source}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillCard({ skill, onControl }: { skill: SkillEntry; onControl: (req: SkillControlRequest) => void }): JSX.Element {
  const [avoidOpen, setAvoidOpen] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  // Show only the suffix after the role prefix to avoid duplicate text matches with role group headers.
  const displayName = skill.skill_id.startsWith(`${skill.agent_role}.`)
    ? skill.skill_id.slice(skill.agent_role.length + 1)
    : skill.skill_id;
  const enabled = skill.enabled !== false; // default true
  const ctrlBtn: CSSProperties = { ...mono, fontSize: 10, background: 'none', border: '1px solid rgba(230,237,243,.2)', borderRadius: 4, color: '#E6EDF3', cursor: 'pointer', padding: '1px 6px' };

  return (
    <div data-skillid={skill.skill_id} style={{ ...card, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ ...mono, fontSize: 12, fontWeight: 700 }}>{displayName}</span>
        <span style={{
          ...mono,
          fontSize: 10,
          color: STATUS_COLOR[skill.status],
          background: `${STATUS_COLOR[skill.status]}22`,
          borderRadius: 4,
          padding: '1px 6px',
        }}>
          {skill.status}
        </span>
        {skill.builtin && <span style={{ ...mono, fontSize: 10, ...dim }} data-testid="builtin-badge">builtin</span>}
        {skill.test_count !== undefined && (
          <span style={{ ...mono, fontSize: 10, ...dim }}>tests: {skill.test_count}</span>
        )}
        {/* STORY-GATE.5: user controls — toggle (un-gated); delete only for non-builtin. */}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            data-testid="skill-toggle"
            onClick={() => onControl({ op: 'toggle', skill_id: skill.skill_id, enabled: !enabled })}
            style={ctrlBtn}
          >
            {enabled ? 'disable' : 'enable'}
          </button>
          {!skill.builtin && (
            <button
              data-testid="skill-delete"
              onClick={() => onControl({ op: 'delete', skill_id: skill.skill_id })}
              style={{ ...ctrlBtn, color: '#E57373' }}
            >
              delete
            </button>
          )}
        </span>
      </div>

      <div style={{ fontSize: 12, marginBottom: 4 }}>{skill.description}</div>

      {skill.status === 'quarantined' && skill.quarantine_reason && (
        <div style={{ ...mono, fontSize: 11, color: '#E57373', marginTop: 4 }}>
          Quarantine: {skill.quarantine_reason}
        </div>
      )}

      {skill.detail && (
        <div style={{ marginTop: 4 }}>
          <button
            onClick={() => setContentsOpen(o => !o)}
            data-testid="skill-contents-toggle"
            style={{ ...mono, fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', ...dim, padding: 0 }}
          >
            {contentsOpen ? '▾' : '▸'} contents (static)
          </button>
          {contentsOpen && <SkillContents detail={skill.detail} />}
        </div>
      )}

      {skill.avoid_lines && skill.avoid_lines.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <button
            onClick={() => setAvoidOpen(o => !o)}
            style={{ ...mono, fontSize: 10, background: 'none', border: 'none', cursor: 'pointer', ...dim, padding: 0 }}
          >
            {avoidOpen ? '▾' : '▸'} avoid ({skill.avoid_lines.length})
          </button>
          {avoidOpen && (
            <ul style={{ margin: '4px 0 0 12px', padding: 0, listStyle: 'disc' }}>
              {skill.avoid_lines.map((line, i) => (
                <li key={i} style={{ ...mono, fontSize: 11, color: '#F2A65A' }}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function RoleGroup({ role, skills, onControl }: { role: string; skills: SkillEntry[]; onControl: (req: SkillControlRequest) => void }): JSX.Element {
  const [open, setOpen] = useState(true);

  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ ...mono, fontSize: 13, fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', color: '#E6EDF3', padding: 0, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>{role}</span>
        <span style={{ ...mono, fontSize: 10, ...dim }}>({skills.length})</span>
      </button>
      {open && skills.map(s => <SkillCard key={s.skill_id} skill={s} onControl={onControl} />)}
    </div>
  );
}

function ToolAllowlistSection({ allowlist }: { allowlist: ToolAllowlistEntry[] }): JSX.Element {
  const th: CSSProperties = { ...mono, fontSize: 10, textTransform: 'uppercase', color: 'rgba(230,237,243,.56)', padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid rgba(230,237,243,.1)' };
  const td: CSSProperties = { ...mono, fontSize: 11.5, padding: '5px 8px', borderBottom: '1px solid rgba(230,237,243,.06)' };

  return (
    <div style={card}>
      <div style={{ ...mono, fontSize: 10, textTransform: 'uppercase', color: 'rgba(230,237,243,.56)', marginBottom: 8 }}>Tool Allowlist</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Role</th>
            <th style={th}>Allowed Tools</th>
          </tr>
        </thead>
        <tbody>
          {allowlist.map(entry => (
            <tr key={entry.role}>
              <td style={td}>{entry.role}</td>
              <td style={td}>
                {entry.allowed_tools.map((tool, i) => (
                  <span key={tool}>{tool}{i < entry.allowed_tools.length - 1 ? ', ' : ''}</span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SkillsPage({ skills, toolAllowlist, onSkillControl }: SkillsPageProps): JSX.Element {
  const onControl = onSkillControl ?? defaultSkillControl;
  const groups = new Map<string, SkillEntry[]>();
  for (const skill of skills) {
    if (!groups.has(skill.agent_role)) groups.set(skill.agent_role, []);
    groups.get(skill.agent_role)!.push(skill);
  }

  return (
    <div data-testid="skills-page-read-only" style={{ padding: 16, color: '#E6EDF3', background: '#0D1117', minHeight: '100vh' }}>
      <div style={{ ...mono, fontSize: 10, textTransform: 'uppercase', color: 'rgba(230,237,243,.56)', marginBottom: 16 }}>
        Skills Catalog
      </div>

      {Array.from(groups.entries()).map(([role, roleSkills]) => (
        <RoleGroup key={role} role={role} skills={roleSkills} onControl={onControl} />
      ))}

      {toolAllowlist && toolAllowlist.length > 0 && (
        <ToolAllowlistSection allowlist={toolAllowlist} />
      )}
    </div>
  );
}

import { useState } from 'react';
import type { CSSProperties } from 'react';

export interface AttemptTierEntry {
  attempt: number;
  tier: 'cheap' | 'mid' | 'strong';
  escalation_reason?: 'failure_count' | 'gene_match' | null;
}

export interface TierHistoryProps { entries: AttemptTierEntry[] }

export function TierHistory({ entries }: TierHistoryProps): JSX.Element {
  const style = {
    table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 },
    th: { textAlign: 'left' as const, padding: '4px 8px', opacity: 0.5, fontWeight: 600, borderBottom: '1px solid rgba(230,237,243,.15)' },
    td: { padding: '4px 8px', borderBottom: '1px solid rgba(230,237,243,.08)' },
  };

  return (
    <div data-testid="tier-history">
      <h3 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Per-Attempt Tier</h3>
      <table style={style.table}>
        <thead>
          <tr>
            <th style={style.th}>Attempt</th>
            <th style={style.th}>Tier</th>
            <th style={style.th}>Escalation Reason</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.attempt}>
              <td style={style.td}>{e.attempt}</td>
              <td style={style.td}>{e.tier}</td>
              <td style={style.td}>{e.escalation_reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ShadowEvalEntry {
  model_ref: string;
  pass_rate: number;
  status_after: 'active' | 'candidate' | 'blocked';
}

export interface ShadowEvalPanelProps { results: ShadowEvalEntry[] }

export function ShadowEvalPanel({ results }: ShadowEvalPanelProps): JSX.Element {
  const style = {
    table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 },
    th: { textAlign: 'left' as const, padding: '4px 8px', opacity: 0.5, fontWeight: 600, borderBottom: '1px solid rgba(230,237,243,.15)' },
    td: { padding: '4px 8px', borderBottom: '1px solid rgba(230,237,243,.08)' },
  };

  return (
    <div data-testid="shadow-eval-panel">
      <h3 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Shadow Eval Results</h3>
      <table style={style.table}>
        <thead>
          <tr>
            <th style={style.th}>Model</th>
            <th style={style.th}>Pass Rate</th>
            <th style={style.th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {results.map(r => (
            <tr key={r.model_ref}>
              <td style={style.td}>{r.model_ref}</td>
              <td style={style.td}>{(r.pass_rate * 100).toFixed(0)}%</td>
              <td style={style.td}>{r.status_after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface EnablementWizardProps {
  steps: string[];
  currentStep: number;
  gateCurrentlyEnabled: boolean;
}

export function EnablementWizard({ steps, currentStep, gateCurrentlyEnabled }: EnablementWizardProps): JSX.Element {
  const style = {
    container: { fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: 12, border: '1px solid rgba(230,237,243,.15)', borderRadius: 4 },
    step: (i: number) => ({
      padding: '4px 0',
      opacity: i < currentStep ? 0.4 : i === currentStep ? 1 : 0.6,
      fontWeight: i === currentStep ? 600 : 400,
    }),
    status: { fontSize: 11, marginTop: 10, opacity: 0.6 },
  };

  return (
    <div data-testid="enablement-wizard-guide-only" style={style.container}>
      <h3 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Enablement Guide</h3>
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {steps.map((step, i) => (
          <li key={i} style={style.step(i)}>{step}</li>
        ))}
      </ol>
      <p style={style.status}>
        Gate status: <strong>{gateCurrentlyEnabled ? 'enabled' : 'disabled'}</strong>
        {' '}— enablement requires human action outside this panel.
      </p>
    </div>
  );
}

// ── STORY-032.7: model-centric registry table + add form + CLI tools ──────────

export type ModelKind = 'openai' | 'openai_responses_codex' | 'anthropic' | 'cli';

export interface ModelRow {
  name: string;
  kind: ModelKind;
  /** Human display name of the supplier (distinct from `kind`, the adapter type). */
  vendor?: string;
  /** Free-text: what the model is good at (router reads this; shown in the table). */
  description?: string;
  /** Structured strengths the deterministic router selects on. */
  capabilities?: string[];
  /** Max context tokens — used for tasks needing a large scan. */
  context_window?: number;
  base_url?: string;
  pricing?: { input?: number; output?: number; cache_input?: number };
  limit?: number;
  cli?: { driver: 'headless' | 'acp'; command: string; args?: string[] };
}

export interface AgentRoutingRow { agent: string; model: string }

// STORY-033.8: the broker populates this env var for the CLI (value never shown).
const CLI_AUTH_ENV: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'CODEX_HOME',
  gemini: 'GEMINI_API_KEY',
};
function authEnvForCommand(cmd?: string): string {
  if (!cmd) return '—';
  const base = cmd.split(/[\\/]/).pop() ?? cmd;
  return CLI_AUTH_ENV[base] ?? '—';
}

export interface ModelRegistryTableProps {
  models: ModelRow[];
  routing: AgentRoutingRow[];
  onAddModel?: (m: ModelRow) => void;
  onAddCli?: (m: ModelRow) => void;
  onRouteChange?: (agent: string, model: string) => void;
}

const BASE_URL_BY_KIND: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openai_responses_codex: 'https://chatgpt.com/backend-api/codex/responses',
  anthropic: 'https://api.anthropic.com',
};

// Plain-language labels for capabilities — the operator never sees raw enum strings.
const CAPABILITY_LABEL: Record<string, string> = {
  'code-generation': 'writes code',
  'debugging': 'debugging',
  'backend': 'backend logic',
  'frontend': 'frontend / UI',
  'long-context': 'whole-codebase analysis',
  'planning': 'planning',
  'review': 'review',
  'assessment': 'assessment',
  'supervision': 'supervision',
};
export function capabilityPhrase(caps?: string[]): string {
  if (!caps?.length) return '—';
  return caps.map(c => CAPABILITY_LABEL[c] ?? c).join(', ');
}

export function ModelRegistryTable(props: ModelRegistryTableProps): JSX.Element {
  const { models, routing, onAddModel, onAddCli, onRouteChange } = props;
  const apiModels = models.filter(m => m.kind !== 'cli');
  const cliModels = models.filter(m => m.kind === 'cli');
  const modelNames = apiModels.map(m => m.name);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<ModelKind>('openai');
  const [baseMode, setBaseMode] = useState<'auto' | 'manual'>('auto');
  const [baseUrl, setBaseUrl] = useState('');
  const [inP, setInP] = useState('');
  const [outP, setOutP] = useState('');
  const [cacheP, setCacheP] = useState('');
  const [limit, setLimit] = useState('');

  const [cliName, setCliName] = useState('');
  const [cliDriver, setCliDriver] = useState<'headless' | 'acp'>('headless');
  const [cliCmd, setCliCmd] = useState('');
  const [cliArgs, setCliArgs] = useState('');

  const th: CSSProperties = { textAlign: 'left', padding: '4px 8px', opacity: 0.5, fontWeight: 600, borderBottom: '1px solid rgba(230,237,243,.15)', fontSize: 11 };
  const td: CSSProperties = { padding: '4px 8px', borderBottom: '1px solid rgba(230,237,243,.08)', fontSize: 11.5 };
  const input: CSSProperties = { fontFamily: 'JetBrains Mono, monospace', fontSize: 11, background: '#0D1117', color: '#E6EDF3', border: '1px solid rgba(230,237,243,.15)', borderRadius: 4, padding: '3px 6px' };

  const submitModel = (): void => {
    if (!name.trim()) return;
    const pricing = (inP || outP || cacheP) ? {
      ...(inP ? { input: Number(inP) } : {}),
      ...(outP ? { output: Number(outP) } : {}),
      ...(cacheP ? { cache_input: Number(cacheP) } : {}),
    } : undefined;
    onAddModel?.({
      name: name.trim(),
      kind,
      base_url: baseMode === 'auto' ? BASE_URL_BY_KIND[kind] : baseUrl.trim(),
      ...(pricing ? { pricing } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
    setName('');
  };

  const submitCli = (): void => {
    if (!cliName.trim() || !cliCmd.trim()) return;
    const args = cliArgs.trim() ? cliArgs.trim().split(/\s+/) : undefined;
    onAddCli?.({ name: cliName.trim(), kind: 'cli', cli: { driver: cliDriver, command: cliCmd.trim(), ...(args ? { args } : {}) } });
    setCliName('');
    setCliCmd('');
    setCliArgs('');
  };

  return (
    <div data-testid="model-registry-table">
      <h3 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Models</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>Name</th><th style={th}>Vendor</th><th style={th}>Description</th><th style={th}>Good at</th><th style={th}>Context</th><th style={th}>Base URL</th><th style={th}>Pricing $/1M (in/out)</th><th style={th}>Limit</th></tr></thead>
        <tbody>
          {apiModels.map(m => (
            <tr key={m.name} data-model-name={m.name}>
              <td style={td}>{m.name}</td>
              <td style={td}>{m.vendor ?? m.kind}</td>
              <td style={td} data-model-description={m.name}>{m.description ?? '—'}</td>
              <td style={td} data-model-goodat={m.name}>{capabilityPhrase(m.capabilities)}</td>
              <td style={td}>{m.context_window ? `${Math.round(m.context_window / 1000)}k` : '—'}</td>
              <td style={td}>{m.base_url ?? '—'}</td>
              <td style={td}>{m.pricing?.input !== undefined ? `${m.pricing.input}/${m.pricing.output ?? '?'}` : 'unknown'}</td>
              <td style={td}>{m.limit ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div data-testid="add-model-form" style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <input aria-label="model name" placeholder="model name" value={name} onChange={e => setName(e.target.value)} style={input} />
        <select aria-label="model kind" value={kind} onChange={e => setKind(e.target.value as ModelKind)} style={input}>
          <option value="openai">openai</option>
          <option value="openai_responses_codex">openai_responses_codex</option>
          <option value="anthropic">anthropic</option>
        </select>
        <select aria-label="base url mode" value={baseMode} onChange={e => setBaseMode(e.target.value as 'auto' | 'manual')} style={input}>
          <option value="auto">base_url: auto</option>
          <option value="manual">base_url: manual</option>
        </select>
        {baseMode === 'manual' && <input aria-label="base url" placeholder="https://…" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} style={input} />}
        <input aria-label="price input" placeholder="$ in" value={inP} onChange={e => setInP(e.target.value)} style={{ ...input, width: 56 }} />
        <input aria-label="price output" placeholder="$ out" value={outP} onChange={e => setOutP(e.target.value)} style={{ ...input, width: 56 }} />
        <input aria-label="price cache" placeholder="$ cache" value={cacheP} onChange={e => setCacheP(e.target.value)} style={{ ...input, width: 56 }} />
        <input aria-label="rate limit" placeholder="limit" value={limit} onChange={e => setLimit(e.target.value)} style={{ ...input, width: 56 }} />
        <button onClick={submitModel} style={{ ...input, cursor: 'pointer' }}>add model</button>
      </div>

      <h3 style={{ fontSize: 12, fontWeight: 600, margin: '16px 0 8px' }}>Agent routing</h3>
      <div data-testid="agent-routing">
        {routing.map(r => (
          <div key={r.agent} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11.5, width: 130 }}>{r.agent}</span>
            <select aria-label={`route ${r.agent}`} value={r.model} onChange={e => onRouteChange?.(r.agent, e.target.value)} style={input}>
              {modelNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        ))}
      </div>

      <hr data-testid="cli-divider" style={{ margin: '18px 0', border: 'none', borderTop: '1px solid rgba(230,237,243,.2)' }} />
      <div data-testid="cli-tools-section">
        <h3 style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>External CLI tools (kind: cli)</h3>
        <p style={{ fontSize: 10.5, opacity: 0.55, margin: '0 0 8px' }}>
          CLI tools register with a <strong>command + args + auth env</strong> instead of a base_url (EPIC-033, driver=headless primary).
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Name</th><th style={th}>Driver</th><th style={th}>Command</th><th style={th}>Args</th><th style={th}>Auth env</th></tr></thead>
          <tbody>
            {cliModels.map(m => (
              <tr key={m.name} data-cli-name={m.name} data-cli-driver={m.cli?.driver}>
                <td style={td}>{m.name}</td>
                <td style={td}>{m.cli?.driver}</td>
                <td style={td}>{m.cli?.command}</td>
                <td style={td}>{m.cli?.args?.length ? m.cli.args.join(' ') : '—'}</td>
                <td style={td} data-cli-auth-env={authEnvForCommand(m.cli?.command)}>{authEnvForCommand(m.cli?.command)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div data-testid="add-cli-form" style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <input aria-label="cli name" placeholder="tool name" value={cliName} onChange={e => setCliName(e.target.value)} style={input} />
          <select aria-label="cli driver" value={cliDriver} onChange={e => setCliDriver(e.target.value as 'headless' | 'acp')} style={input}>
            <option value="headless">headless</option>
            <option value="acp">acp</option>
          </select>
          <input aria-label="cli command" placeholder="CLI command" value={cliCmd} onChange={e => setCliCmd(e.target.value)} style={input} />
          <input aria-label="cli args" placeholder="args (space-separated)" value={cliArgs} onChange={e => setCliArgs(e.target.value)} style={input} />
          <button onClick={submitCli} style={{ ...input, cursor: 'pointer' }}>add CLI tool</button>
        </div>
      </div>
    </div>
  );
}

export interface ApiPageProps {
  tierHistory?: AttemptTierEntry[];
  shadowEval?: ShadowEvalEntry[];
  wizard?: EnablementWizardProps;
  modelRegistry?: ModelRegistryTableProps;
}

export function ApiPage(props: ApiPageProps): JSX.Element {
  const { tierHistory, shadowEval, wizard, modelRegistry } = props;

  const style = {
    page: { fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 24 },
  };

  return (
    <div data-testid="api-page" style={style.page}>
      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 0 }}>API</h2>
      {modelRegistry && <ModelRegistryTable {...modelRegistry} />}
      {tierHistory && <TierHistory entries={tierHistory} />}
      {shadowEval && <ShadowEvalPanel results={shadowEval} />}
      {wizard && <EnablementWizard {...wizard} />}
    </div>
  );
}

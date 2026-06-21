/**
 * STORY-034.6 → EPIC-035 TIER C — Provider-mode monitor (independent page; does NOT touch the
 * existing cockpit).
 *
 * READ-ONLY projection of a recorded provider-mode run: a real model working a story IN-PROCESS
 * through the confined tool layer (EPIC-035 (b), metered OpenAI on api.openai.com). Two equal
 * halves — (1) the isolation gates (the default-deny tool layer, what the real model actually
 * called, the default-deny review) and (2) the story completion flow (sandbox → work → diff →
 * exit gate → adopt). Plain language where user-facing; no control that could start a run or relax
 * isolation (the only button loads/replays an existing trace).
 *
 * (Renamed from CliModeMonitor: the spawn-CLI cage trace was retired with the spawn path in
 * EPIC-035 TIER A/B; this projects the in-process provider path's tool-layer confinement.)
 */
import { useState } from 'react';

export interface ProviderModeTrace {
  run_id: string;
  mode: string;
  summary: { ran: boolean; accepted: boolean; tool_layer_held: boolean; gate_closed_verified: boolean; real_api_calls_after: string };
  isolation: {
    tool_layer: {
      default_deny: boolean;
      surface: string[];
      bash_available: boolean;
      core_imports_ai_sdk: boolean;
      audit: { tool: string; decision: string; default_denied: boolean; executed: boolean; detail: string }[];
      default_denials: { tool: string; reason: string }[];
    };
    real_run: { model: string; endpoint: string; metered: boolean; tools_called: string[]; breaches: number; default_deny_triggered: boolean; input_tokens: number; output_tokens: number; report: string; note: string };
  };
  completion: {
    steps: { step: string; label: string; status: string; changed?: string[]; tools?: string[]; out_of_write_set?: string[] }[];
    diff: string; changed_files: string[]; write_set?: string[]; exit_gate: { verdict: string; out_of_write_set: string[] };
  };
  cost: { input_tokens: number; output_tokens: number; model: string; metered: boolean };
  events: { kind: string; tool?: string; detail?: string }[];
}

const C = { teal: '#5BD6C0', ok: '#5BD6C0', bad: '#E5736B', dim: 'rgba(230,237,243,.56)', faint: 'rgba(230,237,243,.34)', line: 'rgba(230,237,243,.1)', panel: '#121C26' };
const mono = { fontFamily: 'JetBrains Mono, ui-monospace, monospace' } as const;
const Tick = ({ ok }: { ok: boolean }) => <span style={{ color: ok ? C.ok : C.bad, fontWeight: 700 }}>{ok ? '✓' : '✗'}</span>;

export function ProviderModeMonitorView({ trace }: { trace: ProviderModeTrace }) {
  const [replayN, setReplayN] = useState(trace.events.length); // start fully shown; replay can rewind
  const tl = trace.isolation.tool_layer;
  const rr = trace.isolation.real_run;
  const panel = { background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, marginBottom: 14 } as const;
  const h = { fontSize: 13, fontWeight: 700, marginBottom: 10, letterSpacing: .3 } as const;

  return (
    <section data-testid="provider-mode-monitor" style={{ padding: '18px 22px', color: '#E6EDF3', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Provider-mode run · <span style={{ color: C.teal }}>read-only</span></h2>
        <span style={{ ...mono, fontSize: 12, color: C.dim }} data-testid="run-id">{trace.run_id}</span>
        <span style={{ ...mono, fontSize: 11, color: C.faint }}>a real model in-process through the confined tool layer · projection of an existing trace (no run is triggered)</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* ───────── ISOLATION GATES (the tool layer) ───────── */}
        <div>
          <div style={panel} data-testid="tool-layer-status">
            <div style={h}>Isolation — the confined tool layer</div>
            <div style={{ ...mono, fontSize: 11, color: C.dim, marginBottom: 8 }}>
              <Tick ok={tl.default_deny} /> default-deny: only whitelisted tools are allowed; everything else is refused<br />
              <Tick ok={!tl.bash_available} /> no shell — Bash is not on the tool surface<br />
              <Tick ok={!tl.core_imports_ai_sdk} /> the core imports no AI SDK (the model SDK is isolated)
            </div>
            <div style={{ ...mono, fontSize: 11, color: C.faint, marginBottom: 6 }}>allowed tools: {tl.surface.join(', ')}</div>
            {tl.audit.map((a, k) => (
              <div key={k} data-testid="tool-layer-invariant" style={{ ...mono, fontSize: 11, color: C.dim, paddingLeft: 4 }}>
                <Tick ok={a.decision === 'allow' ? a.executed : a.default_denied && !a.executed} />{' '}
                <span style={{ color: a.decision === 'allow' ? C.teal : C.bad }}>{a.tool}</span> — {a.detail}
              </div>
            ))}
          </div>

          <div style={panel} data-testid="real-run-status">
            <div style={h}>What the model actually did (the real metered run)</div>
            <div style={{ ...mono, fontSize: 11, color: C.dim }}>
              <div>model: <span style={{ color: C.teal }}>{rr.model}</span> · {rr.metered ? 'metered' : 'subscription'} · {rr.endpoint}</div>
              <div style={{ marginTop: 4 }}><Tick ok={rr.breaches === 0} /> tools it called: {rr.tools_called.join(', ')} (whitelist only)</div>
              <div><Tick ok={rr.breaches === 0} /> breaches: {rr.breaches} — no Bash, no secret read, no out-of-write-set</div>
              <div><Tick ok={!rr.default_deny_triggered} /> default-deny triggered: {rr.default_deny_triggered ? 'yes' : 'no'} (the model stayed inside the surface)</div>
              <div style={{ color: C.faint, marginTop: 6 }}>{rr.note}</div>
            </div>
          </div>

          <div style={panel} data-testid="default-deny-review">
            <div style={h}>Default-deny review (unexpected tools the layer refused)</div>
            {tl.default_denials.map((d, k) => (
              <div key={k} data-testid="default-deny-item" style={{ ...mono, fontSize: 12, color: C.dim }}>
                <Tick ok={true} /> refused <span style={{ color: C.bad }}>{d.tool}</span> — {d.reason}
              </div>
            ))}
            {tl.default_denials.length === 0 && <div style={{ color: C.dim, fontSize: 12 }}>no unexpected tool was reached for</div>}
          </div>
        </div>

        {/* ───────── STORY COMPLETION FLOW ───────── */}
        <div>
          <div style={panel} data-testid="completion-flow">
            <div style={h}>Story completion flow</div>
            {trace.completion.steps.map((s, k) => {
              const good = s.status !== 'rejected';
              return (
                <div key={k} data-testid="completion-step" style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 8 }}>
                  <Tick ok={good} />
                  <div>
                    <div style={{ fontSize: 12 }}>{s.label}</div>
                    {s.changed && <div style={{ ...mono, fontSize: 11, color: C.dim }}>changed: {s.changed.join(', ')}</div>}
                    {s.tools && s.tools.length > 0 && <div style={{ ...mono, fontSize: 11, color: C.dim }}>tools: {s.tools.join(', ')}</div>}
                  </div>
                </div>
              );
            })}
            <div data-testid="exit-gate-verdict" style={{ marginTop: 8, padding: '8px 10px', background: '#0E1620', borderRadius: 6, ...mono, fontSize: 12 }}>
              exit gate → <b style={{ color: trace.completion.exit_gate.verdict === 'ACCEPTED' ? C.ok : C.bad }}>{trace.completion.exit_gate.verdict}</b>
              {' '}<span style={{ color: C.dim }}>(changes only touched authorized files: {trace.completion.exit_gate.out_of_write_set.length === 0 ? 'yes' : 'NO — ' + trace.completion.exit_gate.out_of_write_set.join(', ')})</span>
            </div>
          </div>

          <div style={panel} data-testid="diff-panel">
            <div style={h}>Diff produced ({trace.completion.changed_files.join(', ')})</div>
            <pre style={{ ...mono, fontSize: 11, color: C.dim, whiteSpace: 'pre-wrap', margin: 0, maxHeight: 180, overflow: 'auto' }}>{trace.completion.diff}</pre>
          </div>

          <div style={panel}>
            <div style={h}>Cost</div>
            <div style={{ ...mono, fontSize: 12, color: C.dim }}>
              {trace.cost.input_tokens} in · {trace.cost.output_tokens} out tokens · {trace.cost.model} · {trace.cost.metered ? 'metered' : 'subscription'} · gate closed &amp; verified: {String(trace.summary.gate_closed_verified)} · real_api_calls now: {trace.summary.real_api_calls_after}
            </div>
          </div>
        </div>
      </div>

      {/* ───────── REPLAY (read-only) ───────── */}
      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={h}>Replay (step through the recorded events)</div>
          <button data-testid="replay-step" onClick={() => setReplayN(n => Math.min(trace.events.length, (n >= trace.events.length ? 0 : n) + 1))}
            style={{ ...mono, fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: 'pointer', background: '#18242F', color: C.teal, border: `1px solid ${C.line}` }}>
            ▸ step
          </button>
          <span style={{ ...mono, fontSize: 11, color: C.faint }}>{replayN}/{trace.events.length}</span>
        </div>
        {trace.events.slice(0, replayN).map((e, k) => (
          <div key={k} data-testid="replay-event" style={{ ...mono, fontSize: 11, color: C.dim }}>
            {e.kind}{e.tool ? `:${e.tool}` : ''} {e.detail ? `— ${e.detail}` : ''}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Fetching wrapper: loads the recorded trace on demand (read-only). */
export function ProviderModeMonitor({ apiBase }: { apiBase: string }) {
  const [trace, setTrace] = useState<ProviderModeTrace | null>(null);
  const [err, setErr] = useState('');
  const load = () => fetch(`${apiBase}/api/provider-mode-run/latest/trace`).then(r => r.json()).then(setTrace).catch(() => setErr('Cannot load the provider-mode trace.'));
  return (
    <div>
      {!trace && (
        <div style={{ padding: 22 }}>
          <button data-testid="load-trace" onClick={load} style={{ ...mono, fontSize: 12, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', background: '#18242F', color: C.teal, border: `1px solid ${C.line}` }}>
            Load / replay the recorded provider-mode run
          </button>
          {err && <div style={{ color: C.bad, marginTop: 10, fontSize: 12 }}>{err}</div>}
        </div>
      )}
      {trace && <ProviderModeMonitorView trace={trace} />}
    </div>
  );
}

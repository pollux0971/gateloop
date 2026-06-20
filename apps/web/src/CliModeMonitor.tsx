/**
 * STORY-034.6 — CLI-mode monitor (independent page; does NOT touch the existing cockpit).
 *
 * READ-ONLY projection of a recorded CLI-mode (STORY-034.5) run: real Claude Code working in
 * the cage. Two equal halves — (1) the isolation gates (two-layer defense, the real bash
 * command stream, the escape review) and (2) the story completion flow (sandbox → work → diff
 * → exit gate → adopt). Plain language where user-facing; no control that could start a run or
 * relax isolation (the only button loads/replays an existing trace).
 */
import { useState } from 'react';

export interface CliModeTrace {
  run_id: string;
  summary: { ran: boolean; accepted: boolean; layer2_held: boolean; gate_closed_verified: boolean; real_api_calls_after: string };
  isolation: {
    layer1: { this_run: { egress_via_proxy: boolean; proxy_log_lines: number; note: string }; hardened_proof: { proven: boolean; invariants: { invariant: string; held: boolean; detail: string }[] } };
    layer2: { held: boolean; invariants: { invariant: string; held: boolean; detail: string }[] };
    bash_commands: { tool: string; confined_to_work: boolean; detail: string }[];
    escape_attempts: { kind: string; detected: boolean }[];
  };
  completion: {
    steps: { step: string; label: string; status: string; changed?: string[]; tools?: string[]; out_of_write_set?: string[] }[];
    diff: string; changed_files: string[]; exit_gate: { verdict: string; out_of_write_set: string[] };
  };
  cost: { input_tokens: number; output_tokens: number; num_turns: number; service_tier: string; subscription: boolean };
  events: { kind: string; tool?: string; detail?: string }[];
}

const C = { teal: '#5BD6C0', ok: '#5BD6C0', bad: '#E5736B', dim: 'rgba(230,237,243,.56)', faint: 'rgba(230,237,243,.34)', line: 'rgba(230,237,243,.1)', panel: '#121C26' };
const mono = { fontFamily: 'JetBrains Mono, ui-monospace, monospace' } as const;
const Tick = ({ ok }: { ok: boolean }) => <span style={{ color: ok ? C.ok : C.bad, fontWeight: 700 }}>{ok ? '✓' : '✗'}</span>;
const plain = (inv: string) => inv
  .replace(/_/g, ' ')
  .replace('cage cannot read any host secret', 'the cage cannot read any host secret')
  .replace('writes confined host untouched', 'writes stay inside the sandbox — the real tree is untouched')
  .replace('injected token in env not on disk', 'the auth token lives only in memory, never written to disk')
  .replace('no home or secret config in cage image', 'no home directory or secrets were baked into the cage');

export function CliModeMonitorView({ trace }: { trace: CliModeTrace }) {
  const [replayN, setReplayN] = useState(trace.events.length); // start fully shown; replay can rewind
  const i = trace.isolation;
  const panel = { background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: 14, marginBottom: 14 } as const;
  const h = { fontSize: 13, fontWeight: 700, marginBottom: 10, letterSpacing: .3 } as const;

  return (
    <section data-testid="cli-mode-monitor" style={{ padding: '18px 22px', color: '#E6EDF3', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>CLI-mode run · <span style={{ color: C.teal }}>read-only</span></h2>
        <span style={{ ...mono, fontSize: 12, color: C.dim }} data-testid="run-id">{trace.run_id}</span>
        <span style={{ ...mono, fontSize: 11, color: C.faint }}>real Claude Code in the cage · projection of an existing trace (no run is triggered)</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* ───────── ISOLATION GATES ───────── */}
        <div>
          <div style={panel} data-testid="layer-defense">
            <div style={h}>Isolation — two-layer defense</div>

            <div data-testid="layer2-status" style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, marginBottom: 6 }}>
                <Tick ok={i.layer2.held} /> <b>Layer 2 — the cage has no secrets</b>{' '}
                <span style={{ color: C.dim }}>(the backstop, verified before Claude ran)</span>
              </div>
              {i.layer2.invariants.map((inv, k) => (
                <div key={k} data-testid="layer2-invariant" style={{ ...mono, fontSize: 11, color: C.dim, paddingLeft: 14 }}>
                  <Tick ok={inv.held} /> {plain(inv.invariant)}
                </div>
              ))}
            </div>

            <div data-testid="layer1-status">
              <div style={{ fontSize: 12, marginBottom: 6 }}>
                <Tick ok={i.layer1.hardened_proof.proven} /> <b>Layer 1 — egress only to api.anthropic.com</b>{' '}
                <span style={{ color: C.dim }}>(proven: only the model host is reachable, everything else blocked)</span>
              </div>
              <div data-testid="layer1-honest-note" style={{ ...mono, fontSize: 11, color: C.faint, paddingLeft: 14 }}>
                this run: {i.layer1.this_run.egress_via_proxy ? 'egress went through the proxy' : 'reached the API directly (the honest finding) — Layer 1 was hardened afterward'}
              </div>
            </div>
          </div>

          <div style={panel} data-testid="bash-stream">
            <div style={h}>What Claude actually ran (its bash / tools)</div>
            {i.bash_commands.map((c, k) => (
              <div key={k} data-testid="bash-command" style={{ ...mono, fontSize: 12 }}>
                <span style={{ color: C.teal }}>{c.tool}</span>{' '}
                <span style={{ color: C.dim }}>— {c.detail}</span>{' '}
                {c.confined_to_work && <span style={{ color: C.ok }}>· confined to /work</span>}
              </div>
            ))}
            {i.bash_commands.length === 0 && <div style={{ color: C.dim, fontSize: 12 }}>no tools recorded</div>}
          </div>

          <div style={panel} data-testid="escape-review">
            <div style={h}>Escape review</div>
            {i.escape_attempts.map((e, k) => (
              <div key={k} data-testid="escape-item" style={{ ...mono, fontSize: 12, color: C.dim }}>
                <Tick ok={!e.detected} /> {e.detected ? `ATTEMPTED: ${e.kind}` : `no attempt to ${e.kind}`}
              </div>
            ))}
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
              {trace.cost.output_tokens} output tokens · {trace.cost.num_turns} turn(s) · {trace.cost.subscription ? 'subscription' : 'api'} · gate closed &amp; verified: {String(trace.summary.gate_closed_verified)} · real_api_calls now: {trace.summary.real_api_calls_after}
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
export function CliModeMonitor({ apiBase }: { apiBase: string }) {
  const [trace, setTrace] = useState<CliModeTrace | null>(null);
  const [err, setErr] = useState('');
  const load = () => fetch(`${apiBase}/api/cli-mode-run/latest/trace`).then(r => r.json()).then(setTrace).catch(() => setErr('Cannot load the CLI-mode trace.'));
  return (
    <div>
      {!trace && (
        <div style={{ padding: 22 }}>
          <button data-testid="load-trace" onClick={load} style={{ ...mono, fontSize: 12, padding: '6px 14px', borderRadius: 6, cursor: 'pointer', background: '#18242F', color: C.teal, border: `1px solid ${C.line}` }}>
            Load / replay the recorded CLI-mode run
          </button>
          {err && <div style={{ color: C.bad, marginTop: 10, fontSize: 12 }}>{err}</div>}
        </div>
      )}
      {trace && <CliModeMonitorView trace={trace} />}
    </div>
  );
}

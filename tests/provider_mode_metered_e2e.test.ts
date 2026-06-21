import { describe, it, expect } from 'vitest';
import { runFixtureStory, runEngineSmoke, runMeteredStory, meteredKeyPresent } from '../scripts/provider-mode-metered.ts';

/**
 * EPIC-035 (b) — a real model works a trivial story IN-PROCESS through the tool layer on a
 * STANDARD, metered OpenAI key (api.openai.com). The metered sibling of the 035.5 subscription
 * E2E; the single controlled variable is the engine/auth/endpoint.
 *
 * The FIXTURE test always runs (CI-safe, zero cost, no network): it drives the WHOLE pipeline
 * (confined mediator + real executor + sandbox + diff + exit gate + observation/default-deny) with
 * a scripted model — proving the metered harness is wired identically to 035.5 with zero
 * subscription code in scope. The LIVE tests run ONLY with LIVE_E2E=1 — they make gated REAL calls
 * on the operator's metered key (cost money; runGated auto opens/closes real_api_calls).
 */
describe('EPIC-035 (b) fixture: metered provider-mode pipeline + observation (zero cost, no network)', () => {
  it('a scripted model writes slugify.mjs, an UNEXPECTED tool is default-denied + recorded, diff is ACCEPTED', async () => {
    const r = await runFixtureStory();
    // completion
    expect(r.ran).toBe(true);
    expect(r.changed_files).toEqual(['slugify.mjs']);
    expect(r.accepted).toBe(true);
    expect(r.out_of_write_set).toEqual([]);
    expect(r.diff).toContain('slugify.mjs');
    // tool-layer: the unexpected bash call was default-denied AND recorded; executor never ran it
    expect(r.default_denials.map((a) => a.bareTool)).toContain('bash');
    expect(r.default_denials.every((a) => a.executorReached === false)).toBe(true);
    // observation stream marks the default-denied attempt
    expect(r.events.some((e) => /tool_default_denied/.test(e.summary))).toBe(true);
    // the report tool was used (allowed) and the file write was allowed-and-executed
    const decisions = r.audit.map((a) => `${a.bareTool}:${a.decision}`);
    expect(decisions).toContain('write_file:allow');
    expect(decisions).toContain('bash:deny');
    expect(decisions).toContain('report:allow');
  });
});

const LIVE = process.env.LIVE_E2E === '1';

describe.skipIf(!LIVE)('EPIC-035 (b) LIVE (gated, metered OpenAI key): real model on api.openai.com through the tool layer', () => {
  it('the broker resolves the metered key (presence only — value never surfaced)', async () => {
    const k = await meteredKeyPresent();
    expect(k.present, 'OPENAI_API_KEY must be resolvable via the broker from the operator .env').toBe(true);
    expect(k.length).toBeGreaterThan(20);
  });

  it('createMeteredEngine reaches api.openai.com: a gated one-token reply comes back, gate auto-closes', async () => {
    const r = await runEngineSmoke();
    expect(r.ran).toBe(true);
    expect(r.gateClosedVerified).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
    console.log('LIVE engine smoke text:', JSON.stringify(r.text), 'usage:', JSON.stringify(r.usage));
  }, 120_000);

  it('runs the story gated; the tool layer holds (no Bash/secret executed); diff ACCEPTED; gate auto-closes', async () => {
    const r = await runMeteredStory();
    // gate discipline
    expect(r.ran).toBe(true);
    expect(r.gateClosedVerified).toBe(true);
    // SAFETY (highest priority): no breach — only whitelisted tools were ever executed
    const executed = r.audit.filter((a) => a.executorReached);
    expect(executed.every((a) => ['write_file', 'read_relevant_files', 'report'].includes(a.bareTool)), JSON.stringify(executed.map((a) => a.bareTool))).toBe(true);
    // any unexpected attempt must have been default-denied (never executed)
    expect(r.default_denials.every((a) => a.executorReached === false)).toBe(true);
    // completion + exit gate
    expect(r.changed_files).toEqual(['slugify.mjs']);
    expect(r.accepted).toBe(true);
    expect(r.out_of_write_set).toEqual([]);
    // surface the real-model behavior for the report (observation, not assertion)
    console.log('LIVE metered audit:', JSON.stringify(r.audit.map((a) => ({ tool: a.bareTool, decision: a.decision, defaultDenied: a.defaultDenied, executed: a.executorReached })), null, 2));
    console.log('LIVE metered changed_files:', r.changed_files, 'accepted:', r.accepted, 'out_of_write_set:', r.out_of_write_set);
    console.log('LIVE metered usage:', JSON.stringify(r.usage));
  }, 180_000);
});

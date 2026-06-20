import { describe, it, expect } from 'vitest';
import { runFixtureStory, runLiveStory, runRefreshRoundTrip } from '../scripts/provider-mode-codex.ts';

/**
 * STORY-035.5 — a real model works a trivial story IN-PROCESS through the tool layer.
 *
 * The FIXTURE test always runs (CI-safe, zero cost, no network): it drives the WHOLE pipeline
 * (confined mediator + real executor + sandbox + diff + exit gate + observation/default-deny) with
 * a scripted model. The LIVE test runs ONLY with LIVE_E2E=1 — it makes a gated REAL call on the
 * operator's Codex subscription (costs money; runGated auto opens/closes real_api_calls).
 */
describe('STORY-035.5 fixture: provider-mode pipeline + observation (zero cost, no network)', () => {
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

describe.skipIf(!LIVE)('STORY-035.5 LIVE (gated, Codex subscription): real model through the tool layer', () => {
  it('runs gated, the tool layer holds (no Bash/secret executed), gate auto-closes', async () => {
    const r = await runLiveStory();
    // gate discipline
    expect(r.ran).toBe(true);
    expect(r.gateClosedVerified).toBe(true);
    // SAFETY (highest priority): no breach — nothing shell-like or secret-ish was ever executed
    const executed = r.audit.filter((a) => a.executorReached);
    expect(executed.every((a) => ['write_file', 'read_relevant_files', 'report'].includes(a.bareTool)), JSON.stringify(executed.map((a) => a.bareTool))).toBe(true);
    // any unexpected attempt must have been default-denied (never executed)
    expect(r.default_denials.every((a) => a.executorReached === false)).toBe(true);
    // surface the real-model behavior for the report (not assertions — observation)
    console.log('LIVE audit:', JSON.stringify(r.audit.map((a) => ({ tool: a.bareTool, decision: a.decision, defaultDenied: a.defaultDenied, executed: a.executorReached })), null, 2));
    console.log('LIVE changed_files:', r.changed_files, 'accepted:', r.accepted, 'out_of_write_set:', r.out_of_write_set);
    console.log('LIVE usage:', JSON.stringify(r.usage));
  }, 180_000);

  it('refresh round-trip: an expired access auto-refreshes headlessly, refreshed token still calls', async () => {
    const r = await runRefreshRoundTrip();
    // the real refresh issued a new access (rotated + persisted; token values never surfaced)
    expect(r.refresh.ok).toBe(true);
    expect(r.refresh.access_changed).toBe(true);
    expect(r.refresh.expires_in_min).toBeGreaterThan(0);
    // the REFRESHED token still makes a successful gated model call (continuation, no re-login)
    expect(r.pingRan).toBe(true);
    expect(r.gateClosedVerified).toBe(true);
    console.log('REFRESH round-trip:', JSON.stringify({ ...r.refresh, pingRan: r.pingRan }));
  }, 120_000);
});

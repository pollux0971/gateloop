/**
 * STORY-029.8 — Live cognition activation (gated, opt-in).
 *
 * Safety-first: the CI-runnable tests prove the gate-aware SKIP behavior and the
 * full activation path (handle → bootstrap/register adapter → budget-guarded
 * routed call → validate output → budget decrement) with an INJECTED MOCK http
 * client — no real network, no key, deterministic. The genuine real-provider run
 * is OPT-IN ONLY: it executes solely when LIVE_E2E=1 AND real_api_calls is open
 * AND a key resolves; otherwise it is skipped with a printed reason. It never
 * runs in CI.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveActivation, readRealApiGate } from '../scripts/driver-loop.ts';
import type {
  TypedSecretHandle, SecretResolver, RealProviderHttpClient, RoutingConfig,
} from '@gateloop/model-gateway';

const HANDLE: TypedSecretHandle = { handle_id: 'provider.openai.default', handle_type: 'api_key', provider: 'openai' };
const ROUTING: RoutingConfig = { agents: { developer: { primary: 'openai/gpt-5.5' }, debugger: { primary: 'openai/gpt-5.5' } } };
const BASE = 'https://api.openai.com/v1';

// Mock http client: returns a valid Developer patch_proposal as OpenAI chat content.
const mockHttp: RealProviderHttpClient = async () => ({
  ok: true, status: 200,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify({ kind: 'patch_proposal', proposal_id: 'PP-live-001', story_id: 'STORY-EVAL-TODO', changed_files: ['todo.mjs'] }) } }],
    usage: { prompt_tokens: 50, completion_tokens: 80 },
  }),
});
const mockResolve: SecretResolver = async () => 'mock-bearer-token';
const noKeyResolve: SecretResolver = async () => '';

// Opt-in gate: the real-provider test runs ONLY with LIVE_E2E=1 + gate open + key present.
const policyPath = path.resolve(fileURLToPath(import.meta.url), '../../configs/policy.yaml');
const gateOpen = readRealApiGate(policyPath);
const hasKey = !!process.env.OPENAI_API_KEY;
const LIVE = process.env.LIVE_E2E === '1' && gateOpen && hasKey;

describe('STORY-029.8 live cognition activation (gated, opt-in)', () => {
  it('gated_and_opt_in_only: gate closed → clean skip, zero network', async () => {
    let networkTouched = false;
    const spyHttp: RealProviderHttpClient = async (...a) => { networkTouched = true; return mockHttp(...a); };
    const r = await liveActivation({ enabled: false, handle: HANDLE, resolveSecret: mockResolve, baseUrl: BASE, routing: ROUTING, httpClient: spyHttp });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/gate closed/);
    expect(networkTouched).toBe(false);
    expect(r.budget_usage.calls).toBe(0);
  });

  it('skips_cleanly_without_key: gate open but no key → clean skip, no throw, zero network', async () => {
    let networkTouched = false;
    const spyHttp: RealProviderHttpClient = async (...a) => { networkTouched = true; return mockHttp(...a); };
    const r = await liveActivation({ enabled: true, handle: HANDLE, resolveSecret: noKeyResolve, baseUrl: BASE, routing: ROUTING, httpClient: spyHttp });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/no key/);
    expect(networkTouched).toBe(false);
  });

  it('never_runs_in_ci: without LIVE_E2E the real-provider test is never selected', () => {
    if (!process.env.LIVE_E2E) expect(LIVE).toBe(false);
    // CI has no LIVE_E2E and a closed gate, so the live path is unreachable there.
  });

  it('end_to_end_path (injected mock, no network): handle→bootstrap→register→routed call→validate→budget decrement', async () => {
    const r = await liveActivation({ enabled: true, handle: HANDLE, resolveSecret: mockResolve, baseUrl: BASE, routing: ROUTING, httpClient: mockHttp });
    expect(r.skipped).toBe(false);
    expect(r.registered.map(x => x.provider_id)).toContain('openai'); // adapter built+registered from the handle
    expect(r.routed_ok).toBe(true);                                    // routed through the gateway
    expect(r.output_valid).toBe(true);                                 // structured output validated
    expect(r.budget_usage.calls).toBe(1);                              // budget decremented by the call
    expect(r.budget_usage.tokens).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain('mock-bearer-token');      // no secret leaks into the result
  });

  // The REAL provider run — opt-in only. Skipped in CI / without the gate + key.
  (LIVE ? it : it.skip)('real_provider_completes_one_story_end_to_end (LIVE_E2E)', async () => {
    const resolveSecret: SecretResolver = async () => process.env.OPENAI_API_KEY as string;
    const r = await liveActivation({ enabled: true, handle: HANDLE, resolveSecret, baseUrl: BASE, routing: ROUTING });
    expect(r.skipped).toBe(false);
    expect(r.routed_ok).toBe(true);
    expect(r.output_valid).toBe(true);
    expect(r.budget_usage.calls).toBeGreaterThan(0);
  });
});

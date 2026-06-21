/**
 * STORY-UST.4 WORK 2 (gated) — the single real-model A/B. Runs ONLY with LIVE_E2E=1
 * (gated, metered, billed). CI/default never spends. real_api_calls is opened/closed +
 * read-back by runGated inside runPonytailAbGated; the key flows via the Secret Broker.
 */
import { describe, it, expect } from 'vitest';
import { runPonytailAbGated } from '../scripts/ust4-ab-gated.ts';
import { meteredKeyPresent } from '../scripts/provider-mode-metered.ts';

const LIVE = process.env.LIVE_E2E === '1';

describe.skipIf(!LIVE)('STORY-UST.4 gated A/B (real metered model): ponytail reduces LOC, correctness held', () => {
  it('key present', async () => {
    const k = await meteredKeyPresent();
    expect(k.present).toBe(true);
  });

  it('ponytail arm writes ≤ LOC and stays correct (three-fold)', async () => {
    const r = await runPonytailAbGated({ budgetUsd: 1 });
    console.error('UST4_AB_GATED', JSON.stringify(r));
    expect(r.ran).toBe(true);
    expect(r.gateClosedVerified).toBe(true);     // gate auto-closed + read-back verified
    expect(r.verdict?.both_correct).toBe(true);   // correctness held in both arms
    expect(r.verdict?.loc_not_increased).toBe(true); // code↓ (ponytail ≤ baseline)
    expect(r.verdict?.three_fold_pass).toBe(true);
  }, 120000);
});

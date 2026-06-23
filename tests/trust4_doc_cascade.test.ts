/**
 * STORY-TRUST.4 — phantom-defense documentation sweep + the two plan cascades.
 *
 * Asserts (not echo-faked) that the REALIGNMENT_PLAN and FRONTEND_PLAN cascades were applied
 * and that every doc which presents an execution-side wall now carries the ADR-0013
 * "no execution-side wall" banner — so NO doc implies a protection that doesn't exist
 * (operator's rule: leave no phantom defense). Also asserts the ONE real, KEPT thing — the
 * tool-layer proposal-shaping (no Bash by construction) — is framed as kept, not removed.
 *
 * Scripted/offline; real_api_calls untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url)); // gateloop/
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

describe('STORY-TRUST.4 — ADR-0013 exists and supersedes the old basis', () => {
  it('the new no-sandbox ADR is in the repo', () => {
    const adr = read('ADR/ADR-0013-no-sandbox-operator-trust.md');
    expect(adr.toLowerCase()).toMatch(/operator-trust|操作者.*信任/);
    expect(adr).toMatch(/不要沙箱|no sandbox|沒有硬牆/i);
  });
});

describe('STORY-TRUST.4 — REALIGNMENT_PLAN cascade', () => {
  const plan = read('GATELOOP_REALIGNMENT_PLAN.md');
  it('old ADR-0013 superseded + ADR-0008 retired', () => {
    expect(plan).toMatch(/no-sandbox-operator-trust/);            // new ADR cited
    expect(plan).toMatch(/取代|superseded|已被取代/);              // old ADR-0013 superseded
    expect(plan).toMatch(/退役.*ADR-0008|ADR-0008.*退役|退役（STORY-TRUST\.1）/); // ADR-0008 retired
  });
  it('Phase 1 / prove-egress removed and §7 deleted (no live wall-proof claim)', () => {
    expect(plan).not.toMatch(/證明牆有效/);                        // the old "prove the wall works" claim is gone
    expect(plan).toMatch(/原 Phase 1.*已刪除|已刪除（ADR-0013）/);  // Phase 1 explicitly deleted
    expect(plan).toMatch(/沙箱作為唯一邊界[~\s]*—?\s*已刪除|已\*\*刪除\*\*/); // §7 tombstoned/deleted
  });
  it('pillar three rewritten to no-hard-wall operator-trust', () => {
    expect(plan).toMatch(/執行端沒有硬牆|沒有硬牆/);
  });
  it('tool-layer no-Bash proposal-shaping is KEPT, not reworded as removed', () => {
    expect(plan).toMatch(/不給 Bash/);
    expect(plan).toMatch(/保留|未移除/);                           // framed as kept
  });
});

describe('STORY-TRUST.4 — FRONTEND_PLAN cascade', () => {
  const plan = read('GATELOOP_FRONTEND_PLAN.md');
  it('SandboxStatusBadge component deleted + §4.4 tombstoned + honest status offered', () => {
    expect(plan).not.toMatch(/function SandboxStatusBadge/);      // the component code is gone
    expect(plan).toMatch(/已刪除（STORY-TRUST\.4|已\*\*刪除\*\*/);  // §4.4 / §1 row tombstoned
    expect(plan).toMatch(/直接在主機（無沙箱）/);                   // honest one-line status
  });
});

describe('STORY-TRUST.4 — docs sweep: execution-wall docs carry the ADR-0013 banner', () => {
  const WALL_DOCS = [
    'docs/policies/CONTAINER_SANDBOX_POLICY.md',
    'docs/architecture/18_DUAL_MODE_BUILDER.md',
    'docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md',
    'docs/architecture/19_AGENT_SDK_MIGRATION.md',
    'docs/architecture/03_TOOL_AND_PERMISSION_MODEL.md',
    'docs/architecture/25_GATE_PHILOSOPHY.md',
    'docs/architecture/14_DEV_CONSOLE_MODEL.md',
    'docs/architecture/26_SCALE_HARDENING.md',
    'docs/architecture/LARGE_PROJECT_READINESS.md',
  ];
  it('each execution-wall doc states there is NO execution-side wall (no phantom defense)', () => {
    for (const d of WALL_DOCS) {
      const doc = read(d);
      expect(doc, d).toMatch(/no execution-side wall/);
      expect(doc, d).toMatch(/ADR-0013/);
      // and the banner KEEPS the one real thing (tool-layer no-Bash), not reworded as removed
      expect(doc, d).toMatch(/no Bash by construction/);
      expect(doc, d).toMatch(/NOT removed/);
    }
  });

  it('the retired skill test-gate is no longer documented as gating (12 §9)', () => {
    const rules = read('docs/architecture/12_RUNTIME_ALGORITHM_RULES.md');
    expect(rules).toMatch(/test-gate is \*\*retired\*\*|test-gate RETIRED/i);
    expect(rules).toMatch(/registered.*# unvalidated|unvalidated — operator-trust/);
  });
});

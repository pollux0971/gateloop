import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPlanningFlowService } from '../apps/api/src/planning';

const REPO = path.resolve(__dirname, '..'); // gateloop/
const POLICY = path.join(REPO, 'configs', 'policy.yaml');

const GOOD_PRD = `# PRD
## Overview
problem. Primary users: operators. Scope — in scope: x; out of scope: y.
## Functional Requirements
FR-1: the system shall do X.
## Non-Functional Requirements
NFR-1: fast.
## Success criteria
- works
`;
const BAD_PRD = '# PRD\n## Overview\nusers and scope.\n## Non-Functional Requirements\nx\n## Success criteria\ny\n'; // no FR section

describe('STORY-PWIRE.2 — POST /api/planning/advance (checklist-gated, record-only)', () => {
  it('advance_succeeds_when_active_stage_checklist_passes', () => {
    const svc = createPlanningFlowService({ repo: REPO });
    const brief = svc.advance({}); // brief stage: ungated
    expect(brief.advanced).toBe(true);
    expect(brief.from).toBe('brief');
    expect(brief.to).toBe('prd');

    const prd = svc.advance({ doc: GOOD_PRD }); // prd: checklist passes
    expect(prd.advanced).toBe(true);
    expect(prd.from).toBe('prd');
    expect(prd.to).toBe('architecture');
    expect(prd.flow.stages.find((s) => s.id === 'prd')!.status).toBe('done');
  });

  it('advance_blocked_returns_failing_items_and_reason_when_incomplete', () => {
    const svc = createPlanningFlowService({ repo: REPO });
    svc.advance({}); // -> prd active
    const blocked = svc.advance({ doc: BAD_PRD });
    expect(blocked.advanced).toBe(false);
    expect(blocked.blocked_reason).toMatch(/checklist \d+\/\d+ — not complete/);
    expect(blocked.failing_items.length).toBeGreaterThan(0);
    // stage NOT advanced — prd is still active, architecture still todo
    expect(blocked.flow.stages.find((s) => s.id === 'prd')!.status).toBe('active');
    expect(blocked.flow.stages.find((s) => s.id === 'architecture')!.status).toBe('todo');
  });

  it('advance_is_record_only_no_policy_write_no_access_gate', () => {
    const before = fs.readFileSync(POLICY, 'utf8');
    const svc = createPlanningFlowService({ repo: REPO });
    // drive several advances (success + blocked) — none may touch policy.yaml
    svc.advance({});
    svc.advance({ doc: BAD_PRD });
    svc.advance({ doc: GOOD_PRD });
    const after = fs.readFileSync(POLICY, 'utf8');
    expect(after).toBe(before); // policy.yaml byte-identical — no policy write

    // the ONLY blocking condition is the quality checklist — no auth/permission field
    const blocked = createPlanningFlowService({ repo: REPO });
    blocked.advance({});
    const r = blocked.advance({ doc: BAD_PRD });
    expect(r).not.toHaveProperty('permission');
    expect(r).not.toHaveProperty('authorized');
    expect(r.blocked_reason).toContain('checklist'); // blocked on quality, not access
  });
});

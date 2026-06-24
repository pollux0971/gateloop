/**
 * STORY-PLLM.4 — POST /api/planning/author: the server-side author→advance loop.
 *
 * Drives the REAL planning-flow service (in-process, the actual handler the route
 * calls) with the default SCRIPTED author — deterministic, offline, zero spend. The
 * loop-internal behaviors (feed-back, convergence, give-up) are unit-tested in
 * planning-steward/src/authorloop.test.ts; this proves the ENDPOINT runs author→advance
 * for the active stage and never leaks a key.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  createPlanningFlowService,
  type RealAuthorDeps,
} from '../apps/api/src/planning';

const REPO = path.resolve(__dirname, '..'); // gateloop/
const POLICY = path.join(REPO, 'configs', 'policy.yaml');

describe('STORY-PLLM.4 — POST /api/planning/author (server-side author→advance loop)', () => {
  it('author_endpoint_runs_author_then_advance_for_active_stage', async () => {
    const svc = createPlanningFlowService({ repo: REPO });

    // brief stage: authoring = record the idea + ungated advance.
    const brief = await svc.author({ idea: 'A tiny URL shortener for teams.' });
    expect(brief.advanced).toBe(true);
    expect(brief.from).toBe('brief');
    expect(brief.to).toBe('prd');
    expect(brief.doc).toContain('URL shortener');

    // prd stage: the scripted author fills the bmad-prd template (placeholder-free) →
    // the real checklist passes → the endpoint advances on the first attempt.
    const prd = await svc.author({});
    expect(prd.stageId).toBe('prd');
    expect(prd.advanced).toBe(true);
    expect(prd.ok).toBe(true);
    expect(prd.attempts).toBeGreaterThanOrEqual(1);
    expect(prd.doc.length).toBeGreaterThan(0);
    // the flow snapshot reflects the advance: prd done, architecture now active.
    expect(prd.flow.stages.find((s) => s.id === 'prd')!.status).toBe('done');
    expect(prd.flow.stages.find((s) => s.id === 'architecture')!.status).toBe('active');
  });

  it('author_is_record_only_no_policy_write', async () => {
    const before = fs.readFileSync(POLICY, 'utf8');
    const svc = createPlanningFlowService({ repo: REPO });
    await svc.author({ idea: 'idea' }); // brief
    await svc.author({}); // prd
    expect(fs.readFileSync(POLICY, 'utf8')).toBe(before); // byte-identical — no policy write
  });

  it('provider_calls_stay_server_side_key_never_in_response', async () => {
    // Wire a REAL-mode author whose engine is built server-side from a resolved "key".
    // The key is used only inside buildEngine; assert it never appears in the response.
    const SECRET = 'sk-NEVER-LEAK-THIS-9f8e7d6c5b4a';
    let keyUsedServerSide = false;
    const realAuthorDeps: RealAuthorDeps = {
      buildEngine: async () => {
        // (production: createMeteredEngine resolves the key here via the broker)
        const key = SECRET;
        keyUsedServerSide = key.length > 0;
        return {
          backendId: 'test-real',
          model: 'test-model',
          async *stream() {
            // a placeholder-free PRD body so the real checklist passes — no key emitted.
            yield {
              type: 'text-delta',
              text:
                '# PRD\n## Overview\nproblem. Primary users: teams. Scope — in scope: a; out of scope: b.\n' +
                '## Functional Requirements\nFR-1: the system shall shorten a URL.\n' +
                '## Non-Functional Requirements\nNFR-1: p95 < 200ms.\n## Success criteria\n- works\n',
            };
            yield { type: 'finish' };
          },
        };
      },
    };
    const svc = createPlanningFlowService({ repo: REPO, realAuthorDeps });
    await svc.author({ idea: 'A tiny URL shortener.' }); // brief
    const prd = await svc.author({ mode: 'real' }); // real author, server-side

    expect(keyUsedServerSide).toBe(true); // the key WAS used (server-side, inside buildEngine)
    expect(prd.advanced).toBe(true); // the real-mode doc passed the checklist
    // INVARIANT: the secret is nowhere in the serialized response.
    const serialized = JSON.stringify(prd);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('sk-');
    // and there is no key-bearing field on the response.
    expect(Object.keys(prd)).not.toContain('key');
    expect(Object.keys(prd)).not.toContain('apiKey');
  });

  it('author_on_complete_flow_reports_clearly', async () => {
    const svc = createPlanningFlowService({ repo: REPO });
    // drive the whole pipeline to completion with the scripted author.
    let guard = 0;
    while (guard++ < 10) {
      const r = await svc.author({ idea: 'A tiny URL shortener.' });
      if (!r.advanced) break;
      if (r.flow.stages.every((s) => s.status === 'done')) break;
    }
    const done = await svc.author({});
    // once complete, authoring reports it cleanly rather than throwing.
    expect(done.advanced).toBe(false);
    expect(done.blocked_reason).toBeTruthy();
  });
});

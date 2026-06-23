/**
 * STORY-FE: the v5 console is wired to live @gateloop/api on every page (not just the
 * console trace). Static source analysis of apps/web/public/console.html (same style as
 * the other web-*.test.ts) — asserts the live-data layer references each new endpoint, the
 * confirm-gated human-action flow, and honest source labels; and that gates stay read-only.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve(__dirname, '..', 'apps', 'web', 'public', 'console.html'), 'utf8');

describe('cockpit live wiring — every page bound to an endpoint', () => {
  it('references each new READ endpoint', () => {
    for (const ep of ['/api/backlog', '/api/pipeline', '/api/checkpoints', '/api/budget',
      '/api/gates', '/api/failure-bank', '/api/models', '/api/routing']) {
      expect(html, `missing wiring for ${ep}`).toContain(ep);
    }
  });
  it('references each interactive action endpoint', () => {
    for (const ep of ['/api/promote', '/api/rollback', '/api/idea-intake',
      '/api/human-gates/', '/api/escalations/']) {
      expect(html, `missing action wiring for ${ep}`).toContain(ep);
    }
  });
  it('has the live render fns + confirm-gated human action + source labels', () => {
    for (const sym of ['livePipeline', 'liveDelivery', 'liveApi', 'liveSettings',
      'liveFailureBank', 'liveStories', 'liveEscalations', 'confirmHumanAction', 'srcPill', 'wirePlanningIntake']) {
      expect(html, `missing ${sym}`).toContain(sym);
    }
    expect(html).toMatch(/gotoPage\s*=\s*function/);          // gotoPage hook
    expect(html).toMatch(/window\.renderStories\s*=\s*liveStories/); // demo override
  });
  it('gates stay read-only: a routing PUT is wired but NO gate-toggle endpoint is called', () => {
    expect(html).toContain("'/api/routing'");                 // routing IS mutable
    expect(html).toContain("method:'PUT'");
    // no gate write/toggle path anywhere in the frontend
    expect(html).not.toMatch(/\/api\/gates\/[^'"`]*\/(enable|toggle|disable|request-toggle)/);
    expect(html).not.toMatch(/real_api_calls[^]{0,40}method:\s*['"]PUT/i);
  });
});

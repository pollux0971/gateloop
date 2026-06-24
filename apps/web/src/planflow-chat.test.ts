import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = path.resolve(__dirname, '..', 'public');
const planflowSrc = fs.readFileSync(path.join(PUBLIC, 'planflow.js'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(PUBLIC, 'console.html'), 'utf8');

// flow snapshots the mocked POST /api/planning/advance returns
const PRD_ACTIVE = {
  source: 'live', mode: 'greenfield', label: 'GREENFIELD', activeIndex: 1,
  stages: [
    { id: 'brief', name: 'B', desc: 'd', skill: null, status: 'done', checklist_passed: null, checklist_total: null },
    { id: 'prd', name: 'PRD', desc: 'd', skill: 'bmad-prd', status: 'active', checklist_passed: 1, checklist_total: 2 },
    { id: 'architecture', name: 'A', desc: 'd', skill: 'bmad-architecture', status: 'todo', checklist_passed: null, checklist_total: null },
  ],
};
const ARCH_ACTIVE = {
  ...PRD_ACTIVE,
  activeIndex: 2,
  stages: [
    { ...PRD_ACTIVE.stages[0] },
    { id: 'prd', name: 'PRD', desc: 'd', skill: 'bmad-prd', status: 'done', checklist_passed: 2, checklist_total: 2 },
    { id: 'architecture', name: 'A', desc: 'd', skill: 'bmad-architecture', status: 'active', checklist_passed: null, checklist_total: null },
  ],
};

const advancedResponse = { advanced: true, from: 'prd', to: 'architecture', blocked_reason: null, failing_items: [], flow: ARCH_ACTIVE };
const blockedResponse = {
  advanced: false, from: 'prd', to: null,
  blocked_reason: 'checklist 1/2 — not complete',
  failing_items: [{ id: 'item-2', text: 'no TBD placeholders', directive: { type: 'no-tbd', arg: '' }, evaluable: true, pass: false }],
  flow: PRD_ACTIVE,
};

function mockFetchReturning(res: unknown) {
  return () => Promise.resolve({ json: () => Promise.resolve(res) } as Response);
}

beforeEach(() => {
  document.body.innerHTML =
    '<div class="stepper"><span class="md" id="step-mode">GREENFIELD</span><div id="steps"></div></div>';
  delete (window as any).__planflow;
  (0, eval)(planflowSrc);
  // seed the node-flow with prd active (as after authoring the PRD)
  (window as any).__planflow.renderFlow(document.getElementById('steps'), PRD_ACTIVE);
});

const statusOf = (stage: string) =>
  document.querySelector(`#steps .step[data-stage="${stage}"]`)?.getAttribute('data-status');

describe('STORY-PWIRE.4 — Planning-Steward chat drives advance', () => {
  it('completing_a_stage_in_chat_advances_the_node_flow', async () => {
    const messages: string[] = [];
    const res = await (window as any).__planflow.chatAdvance({
      doc: 'a complete PRD',
      fetch: mockFetchReturning(advancedResponse),
      base: '',
      onMessage: (h: string) => messages.push(h),
    });
    expect(res.advanced).toBe(true);
    // node flow advanced: prd now done, architecture active
    expect(statusOf('prd')).toBe('done');
    expect(statusOf('architecture')).toBe('active');
    expect(messages.join(' ')).toMatch(/完成/); // chat acknowledged the advance
  });

  it('incomplete_checklist_shows_blocked_reason_and_does_not_advance', async () => {
    const messages: string[] = [];
    const res = await (window as any).__planflow.chatAdvance({
      doc: 'an incomplete PRD',
      fetch: mockFetchReturning(blockedResponse),
      base: '',
      onMessage: (h: string) => messages.push(h),
    });
    expect(res.advanced).toBe(false);
    // node flow NOT advanced: prd still active, architecture still todo
    expect(statusOf('prd')).toBe('active');
    expect(statusOf('architecture')).toBe('todo');
    // chat surfaced the blocked reason + the failing item
    const out = messages.join(' ');
    expect(out).toContain('checklist 1/2 — not complete');
    expect(out).toContain('no TBD placeholders');

    // console.html wires the chat-driven advance to psSay
    expect(consoleHtml).toContain('chatAdvance');
    expect(consoleHtml).toMatch(/psChatAdvance/);
    expect(consoleHtml).toContain('psSay');
  });
});

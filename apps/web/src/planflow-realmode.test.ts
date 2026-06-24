import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = path.resolve(__dirname, '..', 'public');
const planflowSrc = fs.readFileSync(path.join(PUBLIC, 'planflow.js'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(PUBLIC, 'console.html'), 'utf8');

const PRD_ACTIVE = {
  source: 'live', mode: 'greenfield', label: 'GREENFIELD', activeIndex: 1,
  stages: [
    { id: 'brief', name: 'B', desc: 'd', skill: null, status: 'done', checklist_passed: null, checklist_total: null },
    { id: 'prd', name: 'PRD', desc: 'd', skill: 'bmad-prd', status: 'active', checklist_passed: 1, checklist_total: 2 },
    { id: 'architecture', name: 'A', desc: 'd', skill: 'bmad-architecture', status: 'todo', checklist_passed: null, checklist_total: null },
  ],
};
const ARCH_ACTIVE = {
  ...PRD_ACTIVE, activeIndex: 2,
  stages: [
    { ...PRD_ACTIVE.stages[0] },
    { id: 'prd', name: 'PRD', desc: 'd', skill: 'bmad-prd', status: 'done', checklist_passed: 2, checklist_total: 2 },
    { id: 'architecture', name: 'A', desc: 'd', skill: 'bmad-architecture', status: 'active', checklist_passed: null, checklist_total: null },
  ],
};

// POST /api/planning/author responses
const authorAdvanced = {
  ok: true, stageId: 'prd', attempts: 1, doc: '# PRD\n…filled…', advanced: true,
  from: 'prd', to: 'architecture', blocked_reason: null, failing_items: [], flow: ARCH_ACTIVE,
};
const authorBlocked = {
  ok: false, stageId: 'prd', attempts: 3, doc: '# PRD\n…', advanced: false,
  from: 'prd', to: null, blocked_reason: 'gave up after 3 attempt(s) — last block: checklist 1/2 — not complete',
  failing_items: [{ id: 'item-2', text: 'no TBD placeholders', directive: { type: 'no-tbd', arg: '' }, evaluable: true, pass: false }],
  flow: PRD_ACTIVE,
};

/** A fetch mock that records the URL + body it was called with and returns `res`. */
function recordingFetch(res: unknown) {
  const calls: Array<{ url: string; body: any }> = [];
  const fn = (url: string, init?: any) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return Promise.resolve({ json: () => Promise.resolve(res) } as Response);
  };
  return { fn, calls };
}

beforeEach(() => {
  document.body.innerHTML =
    '<div class="stepper"><span class="md" id="step-mode">GREENFIELD</span><div id="steps"></div></div>';
  delete (window as any).__planflow;
  (0, eval)(planflowSrc);
  (window as any).__planflow.renderFlow(document.getElementById('steps'), PRD_ACTIVE);
});

const statusOf = (stage: string) =>
  document.querySelector(`#steps .step[data-stage="${stage}"]`)?.getAttribute('data-status');

describe('STORY-PLLM.5 — frontend real mode (console chat runs the author loop)', () => {
  it('real_mode_toggle_switches_chat_to_author_endpoint_loop', async () => {
    const { fn, calls } = recordingFetch(authorAdvanced);
    const messages: string[] = [];
    const res = await (window as any).__planflow.chatAuthor({
      idea: 'A tiny URL shortener.',
      mode: 'real',
      fetch: fn,
      base: '',
      onMessage: (h: string) => messages.push(h),
    });
    expect(res.advanced).toBe(true);
    // it hit the AUTHOR endpoint (not advance), with mode:'real' from the toggle.
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('/api/planning/author');
    expect(calls[0].body.mode).toBe('real');
    expect(calls[0].body.idea).toBe('A tiny URL shortener.');
    expect(messages.join(' ')).toMatch(/LLM/); // chat acknowledged the real authoring
  });

  it('node_flow_advances_on_real_author_result_and_shows_blocked_reason_when_gated', async () => {
    // converged author → node flow advances
    const ok = recordingFetch(authorAdvanced);
    await (window as any).__planflow.chatAuthor({ idea: 'x', mode: 'real', fetch: ok.fn, base: '' });
    expect(statusOf('prd')).toBe('done');
    expect(statusOf('architecture')).toBe('active');

    // re-seed, then a blocked/give-up author → node flow does NOT advance, reason shown
    (window as any).__planflow.renderFlow(document.getElementById('steps'), PRD_ACTIVE);
    const bad = recordingFetch(authorBlocked);
    const messages: string[] = [];
    const res = await (window as any).__planflow.chatAuthor({
      idea: 'x', mode: 'real', fetch: bad.fn, base: '', onMessage: (h: string) => messages.push(h),
    });
    expect(res.advanced).toBe(false);
    expect(statusOf('prd')).toBe('active'); // not advanced
    expect(statusOf('architecture')).toBe('todo');
    const out = messages.join(' ');
    expect(out).toContain('gave up after 3 attempt(s)');
    expect(out).toContain('no TBD placeholders');
  });

  it('demo_scripted_path_remains_default_no_real_call_on_load', async () => {
    // planflow.js default mode is scripted; author() with no mode sends mode:'scripted'.
    const { fn, calls } = recordingFetch(authorAdvanced);
    await (window as any).__planflow.author({ idea: 'x', fetch: fn, base: '' });
    expect(calls[0].body.mode).toBe('scripted'); // DEFAULT, not real

    // on-load bootstrap only loads the flow (GET) — boot() calls loadFlow, not author.
    expect(consoleHtml).toMatch(/function boot\(\)\{[^}]*loadFlow\(\)/);
    expect(consoleHtml).not.toMatch(/function boot\(\)\{[^}]*author/); // boot never authors
    // real mode is explicitly opt-in and defaults OFF.
    expect(consoleHtml).toContain('window.psRealMode = false');
    expect(consoleHtml).toContain('psSetRealMode');
    expect(consoleHtml).toContain('psChatAuthor');
  });

  it('client_holds_no_key_author_runs_server_side', async () => {
    // the client request body carries only {idea, mode[, maxRewrites]} — never a key.
    const { fn, calls } = recordingFetch(authorAdvanced);
    await (window as any).__planflow.author({ idea: 'x', mode: 'real', maxRewrites: 2, fetch: fn, base: '' });
    const body = calls[0].body;
    expect(Object.keys(body).sort()).toEqual(['idea', 'maxRewrites', 'mode']);
    expect(JSON.stringify(body)).not.toMatch(/key|secret|token|sk-/i);
    // no key/secret literal anywhere in the client source.
    expect(planflowSrc).not.toMatch(/api[_-]?key|secret|sk-[a-z0-9]/i);
    // the chat author wiring sends mode but no key.
    expect(consoleHtml).toContain('chatAuthor');
    expect(consoleHtml).not.toMatch(/apiKey|api_key/);
  });
});

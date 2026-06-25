/* STORY-PWIRE.3 — live planning node-flow, importable via window.__planflow.
 *
 * Renders GET /api/planning/flow into the #steps node-flow using the SAME visual
 * structure as the existing renderSteps (.step done|active|todo / .node / .rail /
 * .ct > .nm/.ds), adding a per-node skill tag + checklist count (the new live
 * data). Keeps the DEMO fallback when the api is offline (LIVE/DEMO badge via the
 * #step-mode data-source attribute). No browser storage. Self-contained browser
 * global so the PWIRE.5 jsdom landing test can call it directly. Flow/quality
 * logic, no access gate (ADR-0013).
 */
(function () {
  function apiBase() {
    return (typeof window !== 'undefined' && window.__GATELOOP_API__) || 'http://127.0.0.1:8787';
  }

  // DEMO fallback — same shape as GET /api/planning/flow (used when the api is offline).
  var DEMO_FLOW = {
    source: 'sample',
    mode: 'greenfield',
    label: 'GREENFIELD',
    activeIndex: 0,
    stages: [
      { id: 'brief', name: '意圖 / Brief', desc: '你想做什麼', skill: null, status: 'active', checklist_passed: null, checklist_total: null },
      { id: 'prd', name: 'PRD', desc: '需求草稿 (FR/NFR)', skill: 'bmad-prd', status: 'todo', checklist_passed: null, checklist_total: null },
      { id: 'architecture', name: '架構', desc: '元件與分層', skill: 'bmad-architecture', status: 'todo', checklist_passed: null, checklist_total: null },
      { id: 'epics', name: '切 story', desc: '可驗收 backlog', skill: 'bmad-epics-stories', status: 'todo', checklist_passed: null, checklist_total: null },
    ],
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function setBadge(source) {
    var sm = document.getElementById('step-mode');
    if (sm) sm.setAttribute('data-source', source === 'live' ? 'live' : 'demo');
  }

  // Render the node-flow into `container` from a flow object. Same .step structure
  // as renderSteps; each node also shows its skill tag and checklist count.
  function renderFlow(container, flow) {
    if (!container) return [];
    var stages = (flow && flow.stages) || [];
    container.innerHTML = '';
    stages.forEach(function (s, i) {
      var status = s.status || 'todo';
      var step = document.createElement('div');
      step.className = 'step ' + status;
      step.setAttribute('data-stage', s.id);
      step.setAttribute('data-status', status);
      var mark = status === 'done' ? '✓' : i + 1;
      var meta = [];
      if (s.skill) meta.push('<span class="nf-skill">' + esc(s.skill) + '</span>');
      if (s.checklist_total != null) meta.push('<span class="nf-check">' + (s.checklist_passed || 0) + '/' + s.checklist_total + '</span>');
      step.innerHTML =
        '<div class="node">' + mark + '</div><div class="rail"></div>' +
        '<div class="ct"><div class="nm">' + esc(s.name) + '</div>' +
        '<div class="ds">' + esc(s.desc) + (meta.length ? ' · ' + meta.join(' · ') : '') + '</div></div>';
      container.appendChild(step);
    });
    return stages;
  }

  function resolve(opts) {
    opts = opts || {};
    return {
      container: opts.container || document.getElementById('steps'),
      // window.fetch must keep its Window `this` binding — calling it as `o.fetch(...)`
      // with an unbound reference throws "Illegal invocation" in real browsers (jsdom is
      // lenient, which is why STORY-PTEST.5's full-browser E2E caught it). bind to window.
      fetch: opts.fetch || (typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : null),
      base: opts.base != null ? opts.base : apiBase(),
      doc: opts.doc || '',
      idea: opts.idea || '',
      // DEFAULT 'scripted' — no real provider call unless the operator opts in.
      mode: opts.mode === 'real' ? 'real' : 'scripted',
      maxRewrites: opts.maxRewrites,
    };
  }

  // Fetch the live flow and render it; fall back to DEMO when the api is offline.
  function loadFlow(opts) {
    var o = resolve(opts);
    if (!o.fetch) {
      setBadge('demo');
      renderFlow(o.container, DEMO_FLOW);
      return Promise.resolve(DEMO_FLOW);
    }
    return o
      .fetch(o.base + '/api/planning/flow')
      .then(function (r) { return r.json(); })
      .then(function (flow) {
        setBadge(flow && flow.source === 'live' ? 'live' : 'demo');
        renderFlow(o.container, flow);
        return flow;
      })
      .catch(function () {
        setBadge('demo');
        renderFlow(o.container, DEMO_FLOW);
        return DEMO_FLOW;
      });
  }

  // POST advance with the authored doc; on response, re-render from the returned flow.
  function advance(opts) {
    var o = resolve(opts);
    if (!o.fetch) return Promise.resolve({ advanced: false, blocked_reason: 'offline', failing_items: [], flow: null });
    return o
      .fetch(o.base + '/api/planning/advance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doc: o.doc }),
      })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.flow) {
          setBadge(res.flow.source === 'live' ? 'live' : 'demo');
          renderFlow(o.container, res.flow);
        }
        return res;
      });
  }

  // STORY-PWIRE.4 — the Planning-Steward chat drives the advance. When a stage's
  // authoring completes in chat, call this with the authored doc: on success the
  // node-flow advances (advance re-renders); when the checklist is incomplete it
  // surfaces the blocked reason + failing items via onMessage and does NOT advance.
  function chatAdvance(opts) {
    opts = opts || {};
    var say = typeof opts.onMessage === 'function' ? opts.onMessage : function () {};
    return advance(opts).then(function (res) {
      if (res && res.advanced) {
        say('✓ ' + (res.from || 'stage') + ' 完成' + (res.to ? '，進入 ' + res.to : '，流程完成') + '。');
      } else {
        var items = (res && res.failing_items) || [];
        var list = items
          .map(function (it) { return '• ' + esc(it && (it.text || it.id) ? it.text || it.id : 'item'); })
          .join('<br>');
        say('⚠ 無法前進：' + esc((res && res.blocked_reason) || 'checklist 未通過') + (list ? '<br>' + list : ''));
      }
      return res;
    });
  }

  // STORY-PLLM.5 — REAL mode: POST /api/planning/author runs the server-side
  // author→advance loop for the active stage and returns the produced doc + flow.
  // The client sends only { idea, mode, maxRewrites } — NO key (the provider call and
  // key resolution happen entirely server-side). On a response, re-render from res.flow.
  function author(opts) {
    var o = resolve(opts);
    if (!o.fetch) return Promise.resolve({ ok: false, advanced: false, blocked_reason: 'offline', failing_items: [], flow: null });
    var body = { idea: o.idea, mode: o.mode };
    if (o.maxRewrites != null) body.maxRewrites = o.maxRewrites;
    return o
      .fetch(o.base + '/api/planning/author', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.flow) {
          setBadge(res.flow.source === 'live' ? 'live' : 'demo');
          renderFlow(o.container, res.flow);
        }
        return res;
      });
  }

  // STORY-PLLM.5 — the chat drives the REAL author loop. Runs ONLY when the operator
  // toggles real mode on (the caller passes mode:'real'); DEMO/scripted stays the
  // default. On a converged author the node-flow advances (author re-rendered it) and
  // the chat acknowledges; on a blocked/give-up result it surfaces the blocked_reason +
  // failing items and does NOT advance.
  function chatAuthor(opts) {
    opts = opts || {};
    var say = typeof opts.onMessage === 'function' ? opts.onMessage : function () {};
    return author(opts).then(function (res) {
      if (res && res.advanced) {
        say('✓ ' + (res.stageId || res.from || 'stage') + ' 已由 LLM 草擬並通過' +
          (res.attempts ? '（' + res.attempts + ' 次嘗試）' : '') +
          (res.to ? '，進入 ' + res.to : '，流程完成') + '。');
      } else {
        var items = (res && res.failing_items) || [];
        var list = items
          .map(function (it) { return '• ' + esc(it && (it.text || it.id) ? it.text || it.id : 'item'); })
          .join('<br>');
        say('⚠ 無法前進：' + esc((res && res.blocked_reason) || '尚未通過') + (list ? '<br>' + list : ''));
      }
      return res;
    });
  }

  window.__planflow = {
    DEMO_FLOW: DEMO_FLOW,
    renderFlow: renderFlow,
    loadFlow: loadFlow,
    advance: advance,
    chatAdvance: chatAdvance,
    author: author,
    chatAuthor: chatAuthor,
  };
})();

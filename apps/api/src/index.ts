import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModels, readRouting, routingRows, applyRoutingUpdate, readRouterConfig, applyRouterConfig } from './registry';
import { loadProviderModeTrace } from './providerModeTrace';
import { handleSkillControl, type SkillCatalog } from './skillControl';
import type { SkillControlRequest } from '@gateloop/skill-runtime';
import {
  readGates, readBacklog, derivePipeline, readCheckpoints, readBudget,
  readQualityBar, readFailureBank, readHumanGates, readReviewerDirections, type CockpitCtx,
} from './cockpit';
import {
  decideEscalation, decideHumanGate, recordPromotion, ideaIntake,
  type HumanActionIO, type DecisionRecord,
} from './humanActions';
import { createPlanningFlowService } from './planning';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');            // gateloop/
const BUILDER = path.resolve(REPO, '..', 'builder');         // sibling of gateloop/ — tracker lives here
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const COCKPIT: CockpitCtx = { repo: REPO, builder: BUILDER, fixtures: FIXTURES };
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8'));
const readFixture = (p: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', p), 'utf8'));

const app = Fastify({ logger: true });
// permissive CORS for the cockpit (dev)
app.addHook('onRequest', (_req, reply, done) => { reply.header('access-control-allow-origin', '*'); reply.header('access-control-allow-headers', '*'); done(); });
app.options('/*', async (_req, reply) => reply.send());

app.get('/health', async () => ({ ok: true }));

// ── Skills: the agent skill catalog (display skills) ──────────────────────────
function loadSkills() {
  const manifest = read('skills/skill_manifest.json');
  return manifest.skills.map((s: any) => {
    let detail: any = {};
    try { detail = read(`${s.path}/skill.json`); } catch { /* template/older */ }
    return {
      skill_id: s.skill_id, agent_role: s.agent_role, status: detail.status ?? s.status,
      description: detail.description ?? '', version: detail.version ?? '',
      depends_on: detail.depends_on ?? [], enhances: detail.enhances ?? [], path: s.path,
    };
  });
}
app.get('/api/skills', async () => ({ skills: loadSkills() }));
app.get('/api/skills/:id', async (req: any, reply) => {
  const s = loadSkills().find((x: any) => x.skill_id === req.params.id);
  return s ?? reply.code(404).send({ error: 'skill not found' });
});

// ── STORY-GATE.5: cockpit skill CONTROL (toggle / add-through-gate / delete non-builtin) ──
// §4d boundary is server-enforced via handleSkillControl → decideSkillControl. The frontend
// can carry user skill DECISIONS but never reach a guardrail; the server refuses overreach
// regardless of what the UI sends. The catalog is the only thing these endpoints can mutate.
const MANIFEST_REL = 'skills/skill_manifest.json';
const skillCatalogIO = {
  read: () => read(MANIFEST_REL) as SkillCatalog,
  write: (c: SkillCatalog) => fs.writeFileSync(path.join(REPO, MANIFEST_REL), JSON.stringify(c, null, 2) + '\n'),
};
function runSkillControl(req: SkillControlRequest, reply: any) {
  const r = handleSkillControl(req, skillCatalogIO);
  return reply.code(r.code).send(r.body);
}
app.put('/api/skills/:id/enabled', async (req: any, reply) =>
  runSkillControl({ op: 'toggle', skill_id: req.params.id, enabled: (req.body ?? {}).enabled }, reply));
app.post('/api/skills', async (req: any, reply) =>
  runSkillControl({ op: 'add', manifest: (req.body ?? {}).manifest }, reply));
app.delete('/api/skills/:id', async (req: any, reply) =>
  runSkillControl({ op: 'delete', skill_id: req.params.id }, reply));
// Generic skill-control endpoint — the §4d boundary refuses any overreaching op/field here too.
app.post('/api/skill-control', async (req: any, reply) =>
  runSkillControl((req.body ?? {}) as SkillControlRequest, reply));

// ── Platform: agents, packages, state machine, plugins, summary ───────────────
const AGENTS = [
  { id: 'planning_steward', boundary: 'Human↔System', does: 'idea → PRD → architecture → epics/stories', never: 'write code, dispatch agents' },
  { id: 'supervisor', boundary: 'System↔Agents', does: 'decide next state, compose task packets, track state', never: 'edit code, run shell, apply/merge/promote, read secrets' },
  { id: 'developer', boundary: '—', does: 'minimal additive reversible patch + initial tests; decompose; pre-flight; spec-conformance', never: 'apply/merge/promote, widen scope, claim completion' },
  { id: 'debugger', boundary: '—', does: 'triage, minimal repair, emit failure gene', never: 'change story goal, delete tests, promote' },
];
const STATE_MACHINE = ['IDEA_INBOX','PLANNING_BUNDLE','SUPERVISOR_CONTRACT','DEVELOPER_PATCH_PROPOSAL','DEVELOPER_PREFLIGHT','SPEC_CONFORMANCE_REVIEW','WORKSPACE_APPLY','VALIDATION','DEBUG_LOOP','CHECKPOINT','HUMAN_GATE','PROMOTION_REVIEW','DONE'];

function loadPackages() {
  const dir = path.join(REPO, 'packages');
  return fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'src', 'index.ts'))).map(d => {
    const src = fs.readFileSync(path.join(dir, d, 'src', 'index.ts'), 'utf8');
    const stubs = (src.match(/not implemented/g) || []).length;
    const hasTests = fs.existsSync(path.join(dir, d, 'src', 'index.test.ts'));
    return { name: `@gateloop/${d}`, stubs, tested: hasTests };
  });
}
app.get('/api/agents', async () => ({ agents: AGENTS }));
app.get('/api/packages', async () => ({ packages: loadPackages() }));
app.get('/api/state-machine', async () => ({ states: STATE_MACHINE }));
app.get('/api/plugins', async () => {
  // plugins.yaml is simple; ship a parsed view without a YAML dep
  return { plugins: [{ id: 'huashu-design', name: 'Huashu Design (花叔Design)', kind: 'design', external: true, source: 'skills.sh', license: 'MIT', install: 'npx skills add alchaincyf/huashu-design', description: 'HTML-native hi-fi design plugin — prototypes, slides, motion, infographics.' }] };
});

// ── Conversations: a run rendered as agent dialogue (display 對話內容) ─────────
app.get('/api/conversations', async () => {
  const c = readFixture('conversation.json');
  return { conversations: [{ run_id: c.run_id, story_id: c.story_id, sample: c.sample, messages: c.messages.length }] };
});
app.get('/api/conversations/:runId', async (req: any, reply) => {
  const c = readFixture('conversation.json');
  return req.params.runId === c.run_id ? c : reply.code(404).send({ error: 'run not found' });
});
app.get('/api/escalations', async () => readFixture('escalations.json'));

// ── Trace: live event stream for the cockpit (UI WORK 4) ──────────────────────
// Returns a TraceEvent[] array the TraceViewer polls in live mode (no more baked-in
// MOCK_TRACE_EVENTS in the frontend). A real run's trace can be wired via the
// GATELOOP_TRACE env (a JSON array of TraceEvent); otherwise a representative fixture
// (showing an Observe catch + self-correct) is served. Supports ?story_id & ?type filters.
app.get('/api/trace', async (req: any) => {
  let events: any[];
  const tracePath = process.env.GATELOOP_TRACE;
  if (tracePath && fs.existsSync(tracePath)) {
    events = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  } else {
    events = readFixture('trace.json');
  }
  const q = req.query ?? {};
  const story = q.story_id as string | undefined;
  const types = ([] as string[]).concat(q.type ?? []);
  return events.filter((e: any) =>
    (!story || e.story_id === story) && (types.length === 0 || types.includes(e.type) || types.includes(e.event_type)),
  );
});

app.get('/api/platform', async () => ({
  name: 'GateLoop', agents: AGENTS.length, packages: loadPackages().length,
  skills: loadSkills().length, states: STATE_MACHINE.length,
}));

// ── Model registry + agent→model routing (UI WORK 2) ──────────────────────────
// Config endpoints: read the live models.yaml + model_routing.yaml and let the
// operator reassign an agent's model. NEVER touches real_api_calls or a secret value.
app.get('/api/models', async () => ({ models: readModels(REPO), routing: routingRows(readRouting(REPO)) }));
app.get('/api/routing', async () => ({ agents: routingRows(readRouting(REPO)) }));
app.put('/api/routing', async (req: any, reply) => {
  const { agent, model } = (req.body ?? {}) as { agent?: string; model?: string };
  const r = applyRoutingUpdate(REPO, agent ?? '', model ?? '');
  return r.ok ? { ok: true, agent, model } : reply.code(400).send({ error: r.error });
});

// Router config (UI WORK D): on/off + plain-language mode (no λ exposed).
app.get('/api/router-config', async () => readRouterConfig(REPO));
app.put('/api/router-config', async (req: any, reply) => {
  const r = applyRouterConfig(REPO, (req.body ?? {}) as { enabled?: boolean; mode?: any });
  return r.ok ? r.config : reply.code(400).send({ error: r.error });
});

// ── Provider-mode monitor (STORY-034.6 → EPIC-035 TIER C): READ-ONLY projection of a real
// provider-mode run trace ──
// Serves the in-process provider-mode tool-layer run (confined tool layer + exit gate) plus the
// verified facts of the gated EPIC-035 (b) metered run. Pure projection — no control here can
// start a run or relax isolation.
app.get('/api/provider-mode-run/:runId/trace', async (req: any, reply) => {
  const t = loadProviderModeTrace(String(req.params.runId));
  return t ? t : reply.code(404).send({ error: 'provider-mode run not found' });
});

// ── Cockpit READ endpoints (make every console page live; each returns source:'live'|'sample') ──
// Read-only over live configs + the sibling builder/ tracker + api fixtures. The 4 global gates
// are DISPLAY-ONLY here — there is no toggle path (EPIC-GATE server boundary; real_api_calls human-only).
app.get('/api/gates', async () => readGates(COCKPIT));
app.get('/api/backlog', async () => readBacklog(COCKPIT));
app.get('/api/pipeline', async () => derivePipeline(COCKPIT));
app.get('/api/checkpoints', async () => readCheckpoints(COCKPIT));
app.get('/api/budget', async () => readBudget(COCKPIT));
app.get('/api/quality-bar', async () => readQualityBar(COCKPIT));
app.get('/api/failure-bank', async () => readFailureBank(COCKPIT));
app.get('/api/human-gates', async () => readHumanGates(COCKPIT));
app.get('/api/reviewer-directions', async (req: any) => readReviewerDirections(COCKPIT, req.query?.story_id));

// ── Planning flow (STORY-PWIRE.1 GET; STORY-PWIRE.2 POST) — live PFLOW engine + PSKILL checker ──
// Record-only: advance's only condition is the quality checklist; no policy.yaml write, no access gate.
const planningFlow = createPlanningFlowService({ repo: REPO });
app.get('/api/planning/flow', async () => planningFlow.getFlow());

// ── Cockpit human-action endpoints (record-only; executed:false; never crosses a trust boundary) ──
// Each records the operator's decision to an append-only log; the dangerous op (promotion, spend,
// scope-widening, gate flips) stays owned by the harness gates. No path writes policy.yaml.
const DECISIONS = path.join(FIXTURES, 'human_decisions.json');
const readDecisionsFile = (): { decisions: DecisionRecord[] } => {
  try { return JSON.parse(fs.readFileSync(DECISIONS, 'utf8')); } catch { return { decisions: [] }; }
};
const humanIO: HumanActionIO = {
  readDecisions: readDecisionsFile,
  appendDecision: (d) => {
    const cur = readDecisionsFile(); cur.decisions = cur.decisions ?? []; cur.decisions.push(d);
    fs.writeFileSync(DECISIONS, JSON.stringify(cur, null, 2) + '\n');
  },
  readEscalations: () => readFixture('escalations.json'),
};
app.post('/api/escalations/:id/decide', async (req: any, reply) => {
  const r = decideEscalation(String(req.params.id), (req.body ?? {}), humanIO); return reply.code(r.code).send(r.body);
});
app.post('/api/human-gates/:id/approve', async (req: any, reply) => {
  const r = decideHumanGate(String(req.params.id), 'approve', (req.body ?? {}), humanIO); return reply.code(r.code).send(r.body);
});
app.post('/api/human-gates/:id/deny', async (req: any, reply) => {
  const r = decideHumanGate(String(req.params.id), 'deny', (req.body ?? {}), humanIO); return reply.code(r.code).send(r.body);
});
app.post('/api/promote', async (req: any, reply) => {
  const r = recordPromotion('promote', (req.body ?? {}), humanIO); return reply.code(r.code).send(r.body);
});
app.post('/api/rollback', async (req: any, reply) => {
  const r = recordPromotion('rollback', (req.body ?? {}), humanIO); return reply.code(r.code).send(r.body);
});
app.post('/api/idea-intake', async (req: any, reply) => {
  const r = ideaIntake((req.body ?? {}), humanIO); return reply.code(r.code).send(r.body);
});

app.listen({ port: 8787, host: '127.0.0.1' }).catch(err => { app.log.error(err); process.exit(1); });

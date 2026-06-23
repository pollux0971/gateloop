/**
 * @gateloop/api — human-action recorders (cockpit interactive flows).
 *
 * SAFETY (mirrors skillControl.ts's server-enforced discipline):
 *   - Every handler RECORDS a human decision to an append-only log and returns
 *     `executed:false`. It NEVER performs the dangerous op (promotion, real spend,
 *     scope-widening, gate flips) — those stay owned by the harness gates.
 *   - No handler writes policy.yaml or any config; the only write is the decision log
 *     (injected IO). A caller-supplied `execute`/`executed` field is ignored.
 *   - The agent has no route here; these fire only from explicit human cockpit actions.
 * Idea-intake reuses @gateloop/planning-steward (real classification + injection guard);
 * it is pure planning computation — no dispatch, no code, no tracker write.
 */
import { classifyIdea, detectPromptInjection } from '@gateloop/planning-steward';

export interface DecisionRecord { kind: string; at: string; by: 'human'; [k: string]: unknown }
export interface HumanActionIO {
  readDecisions(): { decisions: DecisionRecord[] };
  appendDecision(d: DecisionRecord): void;
  readEscalations(): { escalations: Array<{ escalation_id?: string; story_id?: string; options?: Array<{ option_id: string }> }> };
}
export interface HandlerResult { code: number; body: Record<string, unknown> }

const nowIso = (): string => new Date().toISOString();
/** Strip any caller-supplied execution flag — recording only, never executing. */
function safeBody(body: Record<string, unknown>): Record<string, unknown> {
  const { execute, executed, ...rest } = body ?? {};
  void execute; void executed;
  return rest;
}

/** Record the operator's chosen escalation option. Validates option_id ∈ the escalation's options. */
export function decideEscalation(id: string, body: Record<string, unknown>, io: HumanActionIO): HandlerResult {
  const escs = io.readEscalations().escalations ?? [];
  const esc = escs.find((e) => e.escalation_id === id || e.story_id === id);
  if (!esc) return { code: 404, body: { error: `escalation not found: ${id}` } };
  const optionId = String((body ?? {}).option_id ?? '');
  const valid = (esc.options ?? []).map((o) => o.option_id);
  if (!optionId || !valid.includes(optionId)) {
    return { code: 400, body: { error: `option_id must be one of: ${valid.join(', ') || '(none)'}` } };
  }
  io.appendDecision({ kind: 'escalation_decision', escalation_id: id, story_id: esc.story_id, option_id: optionId, by: 'human', at: nowIso() });
  return { code: 200, body: { recorded: true, executed: false, escalation_id: id, option_id: optionId,
    note: 'decision recorded; the chosen action is NOT auto-applied (Supervisor proposes / harness applies under its gates)' } };
}

/** Record a human gate approve/deny. Approving does NOT perform the gated op. */
export function decideHumanGate(id: string, decision: 'approve' | 'deny', body: Record<string, unknown>, io: HumanActionIO): HandlerResult {
  if (decision !== 'approve' && decision !== 'deny') return { code: 400, body: { error: 'decision must be approve or deny' } };
  const clean = safeBody(body);
  io.appendDecision({ kind: 'human_gate_decision', gate_id: id, decision, note: clean.note, by: 'human', at: nowIso() });
  return { code: 200, body: { recorded: true, executed: false, gate_id: id, decision,
    note: 'decision recorded; the gated operation (promotion / secret use / merge) stays human-gated in the harness and is NOT performed here' } };
}

/** Record a promote/rollback decision + evidence. Never performs stable promotion. */
export function recordPromotion(action: 'promote' | 'rollback', body: Record<string, unknown>, io: HumanActionIO): HandlerResult {
  if (action !== 'promote' && action !== 'rollback') return { code: 400, body: { error: 'action must be promote or rollback' } };
  const clean = safeBody(body);
  io.appendDecision({ kind: action, story_id: clean.story_id, evidence_ref: clean.evidence_ref, by: 'human', at: nowIso() });
  return { code: 200, body: { recorded: true, executed: false, action, story_id: clean.story_id ?? null,
    note: 'stable_promotion is human-gated; this records the decision + evidence — the actual promotion remains a separate gated harness step' } };
}

// Deterministic intake questions per classified mode (Planning Steward ambiguity step).
interface IntakeQuestion { id: string; text: string; type: 'text' | 'choice'; options?: string[]; required: boolean }
const INTAKE_QUESTIONS: Record<string, IntakeQuestion[]> = {
  greenfield: [
    { id: 'q_users', text: '主要給誰用？(target users)', type: 'choice', options: ['內部工具', '對外產品', '個人專案'], required: true },
    { id: 'q_scale', text: '資料規模？(影響架構與是否拆多個 story)', type: 'choice', options: ['小 (單機/檔案)', '中 (單一 DB)', '大 (分散式)'], required: true },
  ],
  brownfield: [
    { id: 'q_area', text: '要動既有碼的哪一塊？(module / path)', type: 'text', required: true },
    { id: 'q_contract', text: '是否須保留既有對外介面 (public API) 不變？', type: 'choice', options: ['是，凍結介面', '可演進'], required: true },
  ],
  patch: [{ id: 'q_repro', text: '重現步驟 + 預期/實際行為？', type: 'text', required: true }],
  research_spike: [{ id: 'q_goal', text: '這個 spike 要回答什麼問題？', type: 'text', required: true }],
  checkpoint: [{ id: 'q_scope', text: '要 checkpoint 哪個範圍？', type: 'text', required: true }],
};

/** Classify an idea + return ambiguity questions. Injection-guarded; pure planning, no dispatch. */
export function ideaIntake(body: Record<string, unknown>, io: HumanActionIO): HandlerResult {
  const idea = String((body ?? {}).idea ?? '').trim();
  const modeHint = String((body ?? {}).mode ?? '');
  if (!idea) return { code: 400, body: { error: 'idea is required' } };
  const injection = detectPromptInjection(idea);
  if (injection.detected) {
    return { code: 200, body: { rejected: true, injection_flag: true, signals: injection.signals,
      note: 'idea rejected — prompt-injection signals detected (Planning Steward guard)' } };
  }
  let classified: string;
  try {
    classified = classifyIdea({ title: idea.slice(0, 80), description: idea, source: modeHint === 'brownfield' ? 'brownfield_repo' : undefined } as never);
  } catch {
    return { code: 200, body: { rejected: true, injection_flag: true, note: 'idea rejected by classifier (injection)' } };
  }
  io.appendDecision({ kind: 'idea_intake', idea: idea.slice(0, 200), mode_hint: modeHint, classified, by: 'human', at: nowIso() });
  return { code: 200, body: { classified, injection_flag: false, questions: INTAKE_QUESTIONS[classified] ?? INTAKE_QUESTIONS.greenfield } };
}

import { describe, it, expect } from 'vitest';
import {
  initStepSequencer,
  currentStep,
  nextStep,
  atLastStep,
  isAuthoringStepComplete,
  stepPosition,
  totalSteps,
  StepSequencerError,
  type DocSkill,
  type DocSkillStep,
} from './docskill.js';

const STEPS: DocSkillStep[] = [
  { filename: '01_a.md', content: 'step a' },
  { filename: '02_b.md', content: 'step b' },
  { filename: '03_c.md', content: 'step c' },
];
const SKILL = { steps: STEPS } as Pick<DocSkill, 'steps'>;

describe('STORY-PSKILL.2 — just-in-time step sequencer', () => {
  it('current_step_returned_one_at_a_time_no_future_preload', () => {
    const seq = initStepSequencer(SKILL);
    const cur = currentStep(seq);
    // exactly ONE step object is exposed, the one at the cursor — not the array
    expect(Array.isArray(cur)).toBe(false);
    expect(cur).not.toBeNull();
    expect(cur!.filename).toBe('01_a.md');
    expect(cur!.content).toBe('step a');
    // the only public way to see content is currentStep — future steps are not surfaced
    expect(currentStep(seq)!.filename).toBe('01_a.md'); // still the first, no peeking ahead
    expect(totalSteps(seq)).toBe(3); // count is known, but content is JIT
  });

  it('next_advances_step_position_in_order', () => {
    let seq = initStepSequencer(SKILL);
    expect(stepPosition(seq)).toBe(0);
    expect(currentStep(seq)!.filename).toBe('01_a.md');
    seq = nextStep(seq);
    expect(stepPosition(seq)).toBe(1);
    expect(currentStep(seq)!.filename).toBe('02_b.md');
    seq = nextStep(seq);
    expect(stepPosition(seq)).toBe(2);
    expect(currentStep(seq)!.filename).toBe('03_c.md');
  });

  it('last_step_reports_authoring_step_complete', () => {
    let seq = initStepSequencer(SKILL);
    expect(atLastStep(seq)).toBe(false);
    expect(isAuthoringStepComplete(seq)).toBe(false);
    seq = nextStep(seq); // -> step 2
    expect(isAuthoringStepComplete(seq)).toBe(false);
    seq = nextStep(seq); // -> step 3 (last)
    expect(atLastStep(seq)).toBe(true);
    expect(isAuthoringStepComplete(seq)).toBe(true); // reaching the last step = step-complete
    // advancing past the last step is refused (no silent wrap)
    expect(() => nextStep(seq)).toThrow(StepSequencerError);
    expect(() => nextStep(seq)).toThrow(/already at the last step/);

    // an empty-step skill is vacuously step-complete with no current step
    const empty = initStepSequencer({ steps: [] });
    expect(currentStep(empty)).toBeNull();
    expect(isAuthoringStepComplete(empty)).toBe(true);
    expect(() => nextStep(empty)).toThrow(StepSequencerError);
  });

  it('sequencer_is_deterministic_same_skill_position_same_step', () => {
    // same skill + same position -> identical current step, every time
    const a = initStepSequencer(SKILL);
    const b = initStepSequencer(SKILL);
    expect(currentStep(a)).toEqual(currentStep(b));
    const a1 = nextStep(a);
    const b1 = nextStep(b);
    expect(currentStep(a1)).toEqual(currentStep(b1));
    expect(stepPosition(a1)).toBe(stepPosition(b1));

    // transitions are pure: nextStep does not mutate the input sequencer
    const before = JSON.stringify(a);
    nextStep(a);
    expect(JSON.stringify(a)).toBe(before);

    // currentStep returns a copy, not a live reference into the sequencer
    const cur = currentStep(a)!;
    cur.content = 'mutated';
    expect(currentStep(a)!.content).toBe('step a');
  });
});

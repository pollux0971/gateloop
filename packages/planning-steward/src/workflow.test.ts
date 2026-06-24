import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePlanningWorkflow,
  loadPlanningWorkflowFile,
  PlanningWorkflowConfigError,
  type PlanningWorkflowConfig,
} from './workflow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/planning-steward/src -> gateloop/configs/planning_workflow.yaml
const REAL_CONFIG = path.join(here, '..', '..', '..', 'configs', 'planning_workflow.yaml');

const GOOD = `
mode: greenfield
label: GREENFIELD
stages:
  - id: brief
    name: 意圖 / Brief
    desc: 你想做什麼
    skill: ~
  - id: prd
    name: PRD
    desc: 需求草稿 (FR/NFR)
    skill: bmad-prd
  - id: architecture
    name: 架構
    desc: 元件與分層
    skill: bmad-architecture
  - id: epics
    name: 切 story
    desc: 可驗收 backlog
    skill: bmad-epics-stories
`;

describe('STORY-PFLOW.2 — planning workflow config + loader', () => {
  it('workflow_yaml_parsed_into_ordered_typed_stage_list', () => {
    const cfg = parsePlanningWorkflow(GOOD);
    expect(cfg.mode).toBe('greenfield');
    expect(cfg.label).toBe('GREENFIELD');
    // ordered, exactly the four planning stages in the authored order:
    expect(cfg.stages.map((s) => s.id)).toEqual(['brief', 'prd', 'architecture', 'epics']);
    expect(cfg.stages).toHaveLength(4);

    // the SHIPPED real config file parses to the same ordered spine:
    const real: PlanningWorkflowConfig = loadPlanningWorkflowFile(REAL_CONFIG);
    expect(real.stages.map((s) => s.id)).toEqual(['brief', 'prd', 'architecture', 'epics']);
    expect(real.mode).toBe('greenfield');
  });

  it('each_stage_carries_id_name_desc_skill', () => {
    const cfg = parsePlanningWorkflow(GOOD);
    for (const s of cfg.stages) {
      expect(typeof s.id).toBe('string');
      expect(s.id.length).toBeGreaterThan(0);
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.desc).toBe('string');
      expect(s.desc.length).toBeGreaterThan(0);
      // skill is string | null (brief has no BMAD skill -> null via `~`):
      expect(s.skill === null || typeof s.skill === 'string').toBe(true);
    }
    const brief = cfg.stages.find((s) => s.id === 'brief')!;
    expect(brief.skill).toBeNull();
    const prd = cfg.stages.find((s) => s.id === 'prd')!;
    expect(prd.skill).toBe('bmad-prd');
    // real config: epics stage is driven by the bmad-epics-stories skill
    const real = loadPlanningWorkflowFile(REAL_CONFIG);
    expect(real.stages.find((s) => s.id === 'epics')!.skill).toBe('bmad-epics-stories');
    expect(real.stages.find((s) => s.id === 'brief')!.skill).toBeNull();
  });

  it('malformed_or_missing_config_errors_clearly_not_silent', () => {
    // empty config
    expect(() => parsePlanningWorkflow('')).toThrow(PlanningWorkflowConfigError);
    expect(() => parsePlanningWorkflow('   \n  # only a comment\n')).toThrow(/empty/);

    // missing stages list
    expect(() => parsePlanningWorkflow('mode: x\nlabel: Y\n')).toThrow(/missing 'stages' list/);

    // empty stages list
    expect(() => parsePlanningWorkflow('mode: x\nlabel: Y\nstages:\n')).toThrow(/non-empty ordered list/);

    // missing top-level scalar
    expect(() =>
      parsePlanningWorkflow('mode: x\nstages:\n  - id: a\n    name: n\n    desc: d\n    skill: ~\n'),
    ).toThrow(/missing required top-level scalar 'label'/);

    // stage missing a required field (no skill key)
    expect(() =>
      parsePlanningWorkflow('mode: x\nlabel: Y\nstages:\n  - id: a\n    name: n\n    desc: d\n'),
    ).toThrow(/missing required field 'skill'/);

    // stage with empty required value
    expect(() =>
      parsePlanningWorkflow('mode: x\nlabel: Y\nstages:\n  - id: ~\n    name: n\n    desc: d\n    skill: ~\n'),
    ).toThrow(/field 'id' must be a non-empty string/);

    // duplicate stage id
    const dup =
      'mode: x\nlabel: Y\nstages:\n' +
      '  - id: a\n    name: n\n    desc: d\n    skill: ~\n' +
      '  - id: a\n    name: n2\n    desc: d2\n    skill: ~\n';
    expect(() => parsePlanningWorkflow(dup)).toThrow(/duplicate stage id 'a'/);

    // unknown stage field
    expect(() =>
      parsePlanningWorkflow('mode: x\nlabel: Y\nstages:\n  - id: a\n    bogus: z\n    name: n\n    desc: d\n    skill: ~\n'),
    ).toThrow(/unknown stage field 'bogus'/);

    // unknown top-level key
    expect(() => parsePlanningWorkflow('mode: x\nlabel: Y\nbogus: z\nstages:\n  - id: a\n    name: n\n    desc: d\n    skill: ~\n'))
      .toThrow(/unknown top-level key 'bogus'/);

    // tab indentation rejected
    expect(() => parsePlanningWorkflow('mode: x\nlabel: Y\nstages:\n\t- id: a\n')).toThrow(/tab indentation/);

    // a line that is not key: value
    expect(() => parsePlanningWorkflow('mode x\n')).toThrow(/expected "key: value"/);

    // missing FILE errors clearly, not silently
    expect(() => loadPlanningWorkflowFile('/no/such/planning_workflow.yaml')).toThrow(PlanningWorkflowConfigError);
    expect(() => loadPlanningWorkflowFile('/no/such/planning_workflow.yaml')).toThrow(/cannot read config file/);

    // every thrown error is the typed error (not a silent return)
    let threw = false;
    try {
      parsePlanningWorkflow('not yaml at all just text with no colon');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(PlanningWorkflowConfigError);
    }
    expect(threw).toBe(true);
  });

  it('loader_is_deterministic_same_file_same_stages', () => {
    // same text -> deep-equal result, every time
    const a = parsePlanningWorkflow(GOOD);
    const b = parsePlanningWorkflow(GOOD);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // order-stable, not just set-equal

    // same FILE -> deep-equal result across repeated loads
    const f1 = loadPlanningWorkflowFile(REAL_CONFIG);
    const f2 = loadPlanningWorkflowFile(REAL_CONFIG);
    expect(f1).toEqual(f2);
    expect(JSON.stringify(f1)).toBe(JSON.stringify(f2));

    // comments / blank lines do not change the parse
    const withNoise = GOOD.replace('stages:', '# a comment\n\nstages:');
    expect(parsePlanningWorkflow(withNoise)).toEqual(a);
  });
});

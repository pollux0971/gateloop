import { describe, it, expect } from 'vitest';
import {
  validateAgainstSchema,
  validateEnvelope,
  loadEnvelopeSchema,
  requestEnvelopeForRole,
  responseEnvelopeForRole,
  allRequestEnvelopeNames,
} from './envelope.ts';

// A structurally valid Developer task packet matching the composed envelope (029.2).
export const VALID_DEV_PACKET = {
  packet_id: 'TP-STORY-042.1',
  story_id: 'STORY-042.1',
  story_contract_ref: 'story_contract:STORY-042.1',
  target_agent: 'developer',
  task_title: 'Implement STORY-042.1',
  task_goal: 'Add a token-bucket rate limiter',
  task_details: { background: 'context', expected_behavior: ['limiter_rejects_over_quota'], non_goals: [] },
  allowed_write_set: ['gateloop/packages/api/src/**'],
  forbidden_actions: ['no writes outside the allowed write-set'],
  required_files: { create: ['gateloop/packages/api/src/rate-limiter.ts'], update: [], do_not_touch: [] },
  validation_commands: ['pnpm test api'],
  acceptance_criteria: ['limiter_rejects_over_quota'],
  rollback_requirement: { required: true, expected_content: ['delete rate-limiter.ts'] },
  context_packet: { include_refs: ['story_contract:STORY-042.1'], exclude_patterns: [] },
  output_required: ['patch_proposal'],
};

describe('STORY-032.1 envelope schemas + validation', () => {
  it('envelope_schemas_defined: all four request envelopes load and the role maps resolve', () => {
    for (const name of ['developer_task_packet', 'debugger_task_packet', 'assessment_request', 'review_request']) {
      const schema = loadEnvelopeSchema(name);
      expect(schema.type).toBe('object');
      expect(Array.isArray(schema.required)).toBe(true);
    }
    expect(requestEnvelopeForRole('developer')).toBe('developer_task_packet');
    expect(requestEnvelopeForRole('debugger')).toBe('debugger_task_packet');
    expect(responseEnvelopeForRole('developer')).toBe('patch_proposal');
    expect(allRequestEnvelopeNames().sort()).toEqual(
      ['assessment_request', 'debugger_task_packet', 'developer_task_packet', 'review_request'],
    );
    // response envelopes resolve from specs/ too
    expect(loadEnvelopeSchema('patch_proposal').type).toBeDefined();
    expect(loadEnvelopeSchema('assessment_report').type).toBe('object');
  });

  it('a valid developer task packet passes; malformed is rejected', () => {
    expect(validateEnvelope(VALID_DEV_PACKET, 'developer_task_packet').ok).toBe(true);
    // missing required fields
    expect(validateEnvelope({ story_id: 'x' }, 'developer_task_packet').ok).toBe(false);
    // wrong target_agent const
    expect(validateEnvelope({ ...VALID_DEV_PACKET, target_agent: 'debugger' }, 'developer_task_packet').ok).toBe(false);
    // wrong type for an array field
    expect(validateEnvelope({ ...VALID_DEV_PACKET, allowed_write_set: 'oops' }, 'developer_task_packet').ok).toBe(false);
  });

  it('the minimal validator handles type/required/const/enum/items/additionalProperties', () => {
    const schema = {
      type: 'object',
      required: ['k'],
      additionalProperties: false,
      properties: {
        k: { enum: ['a', 'b'] },
        n: { type: 'number' },
        list: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    };
    expect(validateAgainstSchema({ k: 'a' }, schema).ok).toBe(true);
    expect(validateAgainstSchema({ k: 'c' }, schema).ok).toBe(false);            // enum
    expect(validateAgainstSchema({}, schema).ok).toBe(false);                    // required
    expect(validateAgainstSchema({ k: 'a', extra: 1 }, schema).ok).toBe(false);  // additionalProperties
    expect(validateAgainstSchema({ k: 'a', n: 'x' }, schema).ok).toBe(false);    // type
    expect(validateAgainstSchema({ k: 'a', list: [] }, schema).ok).toBe(false);  // minItems
    expect(validateAgainstSchema({ k: 'a', list: ['x'] }, schema).ok).toBe(true);
  });
});

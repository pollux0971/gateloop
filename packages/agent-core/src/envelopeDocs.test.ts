import { describe, it, expect } from 'vitest';
import {
  generateEnvelopeDoc,
  renderEnvelopeDoc,
  envelopeDocsForRole,
  envelopeDocsAreFresh,
} from './envelopeDocs.ts';
import { loadEnvelopeSchema } from './envelope.ts';

describe('STORY-032.2 self-documenting prompts', () => {
  it('envelope_docs_generated_from_schema: doc fields/descriptions come from the schema', () => {
    const schema = loadEnvelopeSchema('developer_task_packet');
    const doc = generateEnvelopeDoc('developer_task_packet');
    expect(doc.title).toBe(schema.title);
    expect(doc.description).toBe(schema.description);
    // every field's description is exactly the schema's (no hand-written prose)
    for (const f of doc.fields) {
      expect(f.description).toBe(schema.properties[f.name].description ?? '');
    }
    // required flag tracks the schema's required list
    expect(doc.fields.find(f => f.name === 'allowed_write_set')!.required).toBe(true);
    // const + array types are rendered
    expect(doc.fields.find(f => f.name === 'target_agent')!.type).toContain('const');
  });

  it('prompt_section_matches_current_schema: rendered section carries the schema field notes', () => {
    const section = envelopeDocsForRole('developer');
    expect(section).toContain('DeveloperTaskPacket');
    // a per-field note pulled from the schema description
    const accDesc = loadEnvelopeSchema('developer_task_packet').properties.acceptance_criteria.description;
    expect(section).toContain(accDesc);
    expect(section).toContain('`allowed_write_set`');
    // debugger role gets its own envelope
    expect(envelopeDocsForRole('debugger')).toContain('DebuggerTaskPacket');
    // a role without a request envelope gets an empty section
    expect(envelopeDocsForRole('supervisor')).toBe('');
  });

  it('stale_generated_section_fails_check / no_handwritten_envelope_docs', () => {
    const fresh = renderEnvelopeDoc(generateEnvelopeDoc('developer_task_packet'));
    expect(envelopeDocsAreFresh(fresh, 'developer_task_packet')).toBe(true);
    // a hand-edited / stale section no longer matches the schema-generated one
    const stale = fresh.replace(/allowed_write_set/g, 'write_set_OLD');
    expect(envelopeDocsAreFresh(stale, 'developer_task_packet')).toBe(false);
    // even a tiny hand-written addition fails the check (docs must be generated)
    expect(envelopeDocsAreFresh(fresh + '\n- handwritten note', 'developer_task_packet')).toBe(false);
  });
});

/**
 * @gateloop/agent-core — envelope documentation (STORY-032.2)
 *
 * Each agent's system prompt includes a section describing the envelope types it
 * receives, with per-field notes. That section is GENERATED from the schema
 * `description` fields — never hand-written — so prompt and schema can never drift.
 * A stale generated section fails a check. This generated text is also the input
 * to the introspection prompt view (STORY-032.4/032.5).
 * Design: docs/architecture/16_MODEL_REGISTRY_AND_INTROSPECTION.md
 */
import { loadEnvelopeSchema, requestEnvelopeForRole, type JsonSchema } from './envelope.ts';

export interface EnvelopeFieldDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface EnvelopeDoc {
  envelope: string;
  title: string;
  description: string;
  fields: EnvelopeFieldDoc[];
}

function fieldType(sub: JsonSchema): string {
  if (sub.const !== undefined) return `const ${JSON.stringify(sub.const)}`;
  if (Array.isArray(sub.enum)) return `enum(${sub.enum.join('|')})`;
  if (Array.isArray(sub.type)) return sub.type.join('|');
  if (sub.type === 'array') return sub.items?.type ? `${sub.items.type}[]` : 'array';
  return sub.type ?? 'any';
}

/**
 * STORY-032.2: derive a structured envelope doc from a schema — title, description,
 * and per-field {type, required, description} pulled straight from the schema.
 * No hand-written prose: every line is sourced from the schema.
 */
export function generateEnvelopeDoc(schemaName: string): EnvelopeDoc {
  const schema = loadEnvelopeSchema(schemaName);
  const required = new Set<string>((schema.required ?? []) as string[]);
  const fields: EnvelopeFieldDoc[] = Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)
    .map(([name, sub]) => ({
      name,
      type: fieldType(sub),
      required: required.has(name),
      description: sub.description ?? '',
    }));
  return {
    envelope: schemaName,
    title: schema.title ?? schemaName,
    description: schema.description ?? '',
    fields,
  };
}

/** Render an envelope doc as a deterministic prompt section. */
export function renderEnvelopeDoc(doc: EnvelopeDoc): string {
  const lines: string[] = [`### Envelope: ${doc.title} (${doc.envelope})`, doc.description, '', 'Fields:'];
  for (const f of doc.fields) {
    lines.push(`- \`${f.name}\` (${f.type}${f.required ? ', required' : ''}): ${f.description}`);
  }
  return lines.join('\n');
}

/**
 * STORY-032.2: the envelope-documentation section for an agent role — the rendered
 * doc for the request envelope that role receives. Empty for roles without one.
 */
export function envelopeDocsForRole(role: string): string {
  const name = requestEnvelopeForRole(role);
  if (!name) return '';
  return renderEnvelopeDoc(generateEnvelopeDoc(name));
}

/**
 * STORY-032.2 stale check: a provided (cached/embedded) envelope-doc section must
 * equal the freshly generated one. If the schema changed and the section did not,
 * this returns false — the build/test fails, forcing regeneration. Guarantees the
 * docs are never hand-written and never drift.
 */
export function envelopeDocsAreFresh(provided: string, schemaName: string): boolean {
  return provided.trim() === renderEnvelopeDoc(generateEnvelopeDoc(schemaName)).trim();
}

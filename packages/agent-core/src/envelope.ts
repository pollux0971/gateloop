/**
 * @gateloop/agent-core — envelope validation (STORY-032.1)
 *
 * Every cross-agent call is a JSON envelope validated on both ends:
 *   compose → validate request envelope → send → receive → validate response.
 * The request envelopes live in specs/agent_envelope/; the response envelopes are
 * the existing specs/{patch_proposal,diagnosis_report,assessment_report}.schema.json.
 *
 * Validation is a small, dependency-free JSON-Schema subset validator (the codebase
 * validates by code, not ajv): enough for object/array/string/number/boolean/null,
 * required, properties, additionalProperties, const, enum, items, minItems, minLength.
 * The schema files are the single source of truth — also the input to the
 * self-documenting prompt docs (STORY-032.2).
 * Design: docs/architecture/16_MODEL_REGISTRY_AND_INTROSPECTION.md
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface SchemaValidationResult { ok: boolean; errors: string[] }

export type JsonSchema = Record<string, any>;

// ── Minimal JSON-Schema-subset validator ──────────────────────────────────────

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (t === 'number') return typeof v === 'number';
  return typeOf(v) === t;
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = '$'): SchemaValidationResult {
  const errors: string[] = [];

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(value, t))) {
      errors.push(`${path}: expected type ${types.join('|')}, got ${typeOf(value)}`);
      return { ok: false, errors }; // wrong type — deeper checks are noise
    }
  }

  if (typeOf(value) === 'string') {
    if (typeof schema.minLength === 'number' && (value as string).length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }

  if (typeOf(value) === 'array') {
    const arr = value as unknown[];
    if (typeof schema.minItems === 'number' && arr.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      arr.forEach((item, i) => {
        const r = validateAgainstSchema(item, schema.items, `${path}[${i}]`);
        errors.push(...r.errors);
      });
    }
  }

  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props: Record<string, JsonSchema> = schema.properties ?? {};
    for (const req of (schema.required ?? []) as string[]) {
      if (obj[req] === undefined) errors.push(`${path}: missing required property '${req}'`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) errors.push(`${path}: additional property '${k}' not allowed`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (obj[k] !== undefined) {
        const r = validateAgainstSchema(obj[k], sub, `${path}.${k}`);
        errors.push(...r.errors);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Schema loading ────────────────────────────────────────────────────────────

const SPECS_DIR = fileURLToPath(new URL('../../../specs/', import.meta.url));
const schemaCache = new Map<string, JsonSchema>();

/** Resolve a schema by name: request envelopes live in specs/agent_envelope/,
 *  response envelopes in specs/. Cached after first read. */
export function loadEnvelopeSchema(name: string): JsonSchema {
  const cached = schemaCache.get(name);
  if (cached) return cached;
  const candidates = [
    `${SPECS_DIR}agent_envelope/${name}.schema.json`,
    `${SPECS_DIR}${name}.schema.json`,
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const schema = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonSchema;
      schemaCache.set(name, schema);
      return schema;
    }
  }
  throw new Error(`envelope schema not found: ${name} (looked in specs/agent_envelope/ and specs/)`);
}

/** Validate a value against a named envelope schema. */
export function validateEnvelope(value: unknown, schemaName: string): SchemaValidationResult {
  return validateAgainstSchema(value, loadEnvelopeSchema(schemaName));
}

// ── Role → envelope registries ────────────────────────────────────────────────

/** Request envelope (the task packet / request sent TO this role). */
export const REQUEST_ENVELOPE_BY_ROLE: Record<string, string> = {
  developer: 'developer_task_packet',
  debugger: 'debugger_task_packet',
  assessor: 'assessment_request',
  reviewer: 'review_request',
};

/** Response envelope (the structured output this role returns). */
export const RESPONSE_ENVELOPE_BY_ROLE: Record<string, string> = {
  developer: 'patch_proposal',
  assessor: 'assessment_report',
  reviewer: 'diagnosis_report',
};

export function requestEnvelopeForRole(role: string): string | null {
  return REQUEST_ENVELOPE_BY_ROLE[role] ?? null;
}

export function responseEnvelopeForRole(role: string): string | null {
  return RESPONSE_ENVELOPE_BY_ROLE[role] ?? null;
}

/** All request envelope schema names (for prompt-doc generation, STORY-032.2). */
export function allRequestEnvelopeNames(): string[] {
  return [...new Set(Object.values(REQUEST_ENVELOPE_BY_ROLE))];
}

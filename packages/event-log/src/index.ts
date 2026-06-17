/**
 * @gateloop/event-log
 *
 * Append-only trace. Monotonic sequence + previous_event_hash chain make the raw
 * trace tamper-evident; redaction runs before append so no secret is ever written.
 * Schema: gateloop/specs/trace_event.schema.json
 * Invariant: the log is never rewritten/compacted (see RUNTIME_INVARIANTS §6).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

export interface TraceEvent {
  event_id: string;
  run_id: string;
  seq: number;                       // monotonic within a run
  type: string;
  timestamp: string;
  agent_role?: string;
  artifact_refs?: string[];
  previous_event_hash?: string | null;
  hash?: string;                     // sha256 over the event minus this field
  payload?: Record<string, unknown>;
}

const SECRET_VALUE = /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

/** Recursively redact secret-looking strings before anything is logged. */
export function redact<T>(value: T): T {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '«redacted»') as unknown as T;
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) as T;
  return value;
}

export function hashEvent(e: Omit<TraceEvent, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex');
}

export function createTraceEvent(args: {
  run_id: string; seq: number; type: string; agent_role?: string;
  artifact_refs?: string[]; previous_event_hash?: string | null; payload?: Record<string, unknown>;
}): TraceEvent {
  const base: Omit<TraceEvent, 'hash'> = {
    event_id: crypto.randomUUID(),
    run_id: args.run_id,
    seq: args.seq,
    type: args.type,
    timestamp: new Date().toISOString(),
    agent_role: args.agent_role,
    artifact_refs: args.artifact_refs ?? [],
    previous_event_hash: args.previous_event_hash ?? null,
    payload: redact(args.payload ?? {})
  };
  return { ...base, hash: hashEvent(base) };
}

/** Append one event as a JSONL line (atomic-ish append). */
export function appendJsonl(file: string, e: TraceEvent): void {
  fs.appendFileSync(file, JSON.stringify(e) + '\n');
}
export function readJsonl(file: string): TraceEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as TraceEvent);
}

export interface ValidationResult { ok: boolean; errors: string[] }
/** Structural check + hash-chain integrity over a run's events. */
export function validateTraceEvent(events: TraceEvent[]): ValidationResult {
  const errors: string[] = [];
  let prev: string | null = null;
  events.forEach((e, i) => {
    if (e.seq !== i) errors.push(`seq gap at index ${i}: ${e.seq}`);
    if ((e.previous_event_hash ?? null) !== prev) errors.push(`hash chain break at seq ${e.seq}`);
    const { hash, ...rest } = e;
    if (hash !== hashEvent(rest)) errors.push(`hash mismatch at seq ${e.seq}`);
    prev = e.hash ?? null;
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Append the NEXT event to a per-run JSONL file, computing seq + previous_event_hash
 * from the file's tail so callers never pass seq by hand (Codex #5). One file per run.
 */
export function appendNextEvent(file: string, args: {
  run_id: string; type: string; agent_role?: string;
  artifact_refs?: string[]; payload?: Record<string, unknown>;
}): TraceEvent {
  const existing = readJsonl(file);
  const last = existing[existing.length - 1];
  const e = createTraceEvent({
    run_id: args.run_id, type: args.type, agent_role: args.agent_role,
    artifact_refs: args.artifact_refs, payload: args.payload,
    seq: last ? last.seq + 1 : 0,
    previous_event_hash: last ? (last.hash ?? null) : null,
  });
  appendJsonl(file, e);
  return e;
}

// ── STORY-031.3: resolve a trace_ref back to the full event ───────────────────
//
// A summary entry or handoff-card line holds a small trace_ref ("trace#evt_4821");
// the full original entry stays in the trace, reached on demand via this resolver.
// Detail is reachable without being resident in context. Self-contained (no shared
// dependency): accepts a "trace#<id>[@sha]" ref OR a raw event_id.
// Design: docs/architecture/15_CONTEXT_INHERITANCE_AND_COMPACTION.md.

/** Extract the event_id from a "trace#<id>[@sha]" ref, or pass through a raw event_id. */
export function eventIdFromTraceRef(ref: string): string {
  const m = /^trace#([A-Za-z0-9_.-]+)(?:@[0-9a-fA-F]{7,40})?$/.exec(ref.trim());
  return m ? m[1] : ref.trim();
}

/** STORY-031.3: resolve a trace_ref (or raw event_id) to the full trace event, or null. */
export function resolveTraceRef(ref: string, events: TraceEvent[]): TraceEvent | null {
  const id = eventIdFromTraceRef(ref);
  return events.find(e => e.event_id === id) ?? null;
}

/** STORY-031.3: resolve a trace_ref against a trace JSONL file on disk. */
export function resolveTraceRefFromFile(ref: string, file: string): TraceEvent | null {
  return resolveTraceRef(ref, readJsonl(file));
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTraceEvent, redact, appendJsonl, readJsonl, appendNextEvent, validateTraceEvent,
  resolveTraceRef, resolveTraceRefFromFile, eventIdFromTraceRef } from './index';

let file: string;
beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chev-')), 'events.jsonl'); });
afterEach(() => { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {} });

describe('event-log', () => {
  it('create_trace_event_has_uuid_and_hash', () => {
    const e = createTraceEvent({ run_id: 'r1', seq: 0, type: 'x' });
    expect(e.event_id).toMatch(/[0-9a-f-]{36}/); expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('redact_removes_secret_values', () => {
    expect(JSON.stringify(redact({ k: 'sk-ABCDEFGH1234567890' }))).not.toContain('sk-ABCDEFGH');
  });
  it('redaction_runs_before_append', () => {
    const e = createTraceEvent({ run_id: 'r1', seq: 0, type: 'x', payload: { token: 'ghp_ABCDEFGH1234567890' } });
    expect(JSON.stringify(e.payload)).toContain('«redacted»');
  });
  it('append_and_read_jsonl_roundtrip', () => {
    const e = createTraceEvent({ run_id: 'r1', seq: 0, type: 'x' });
    appendJsonl(file, e); expect(readJsonl(file)[0].event_id).toBe(e.event_id);
  });
  it('append_next_event_auto_increments_seq', () => {
    appendNextEvent(file, { run_id: 'r1', type: 'a' });
    const e2 = appendNextEvent(file, { run_id: 'r1', type: 'b' });
    expect(e2.seq).toBe(1);
  });
  it('append_next_event_chains_previous_hash', () => {
    const e1 = appendNextEvent(file, { run_id: 'r1', type: 'a' });
    const e2 = appendNextEvent(file, { run_id: 'r1', type: 'b' });
    expect(e2.previous_event_hash).toBe(e1.hash);
  });
  it('validate_trace_event_passes_for_valid_chain', () => {
    appendNextEvent(file, { run_id: 'r1', type: 'a' }); appendNextEvent(file, { run_id: 'r1', type: 'b' });
    expect(validateTraceEvent(readJsonl(file)).ok).toBe(true);
  });
  it('validate_trace_event_detects_seq_gap', () => {
    const a = createTraceEvent({ run_id: 'r1', seq: 0, type: 'a' });
    const b = createTraceEvent({ run_id: 'r1', seq: 5, type: 'b', previous_event_hash: a.hash });
    expect(validateTraceEvent([a, b]).ok).toBe(false);
  });
  it('validate_trace_event_detects_hash_chain_break', () => {
    const a = createTraceEvent({ run_id: 'r1', seq: 0, type: 'a' });
    const b = createTraceEvent({ run_id: 'r1', seq: 1, type: 'b', previous_event_hash: 'deadbeef' });
    expect(validateTraceEvent([a, b]).ok).toBe(false);
  });

  // ── STORY-031.3: resolve a trace_ref back to the full event ─────────────────

  it('resolver_returns_full_entry_from_ref', () => {
    const a = appendNextEvent(file, { run_id: 'r1', type: 'summary', payload: { text: 'refactored cache logic', detail: 'full diff and reasoning here' } });
    appendNextEvent(file, { run_id: 'r1', type: 'other', payload: { x: 1 } });
    const events = readJsonl(file);
    // resolve by "trace#<id>" ref → the full original event (payload included)
    const resolved = resolveTraceRef(`trace#${a.event_id}`, events);
    expect(resolved).not.toBeNull();
    expect(resolved!.event_id).toBe(a.event_id);
    expect((resolved!.payload as any).detail).toBe('full diff and reasoning here');
    // raw event_id and a ref with a commit sha both resolve
    expect(resolveTraceRef(a.event_id, events)!.event_id).toBe(a.event_id);
    expect(resolveTraceRef(`trace#${a.event_id}@9af3c1a`, events)!.event_id).toBe(a.event_id);
    expect(eventIdFromTraceRef(`trace#${a.event_id}@9af3c1a`)).toBe(a.event_id);
    // an unknown ref resolves to null
    expect(resolveTraceRef('trace#evt_does_not_exist', events)).toBeNull();
  });

  it('detail_reachable_without_being_resident', () => {
    // context holds only the small ref; the full entry is reachable from the trace file
    const evt = appendNextEvent(file, { run_id: 'r1', type: 'summary', payload: { text: 'short summary', big_detail: 'x'.repeat(5000) } });
    const refOnly = `trace#${evt.event_id}`;          // this is all that lives in context
    const full = resolveTraceRefFromFile(refOnly, file);
    expect(full).not.toBeNull();
    expect((full!.payload as any).big_detail.length).toBe(5000);
  });
});

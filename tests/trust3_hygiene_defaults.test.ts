/**
 * STORY-TRUST.3 — the two KEPT hygiene defaults stay functional and are honestly labelled
 * "hygiene, not a wall" (ADR-0013 operator-trust). These are NOT execution-side walls and do
 * NOT restrict the agent; they protect the operator's own data/keys from an accident.
 *
 *   (1) trace/log secret masking  — event-log `redact()` / `createTraceEvent()`
 *   (2) force-push pre-backup      — harness-core protectiveBackstops (proven in that package)
 *
 * Scripted/offline; real_api_calls untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, createTraceEvent } from '@gateloop/event-log';

const repoRoot = fileURLToPath(new URL('../', import.meta.url)); // gateloop/

describe('STORY-TRUST.3 hygiene default #1 — trace/log secret masking stays functional', () => {
  it('redact() still masks the operator\'s own keys out of a value (kept functional)', () => {
    const masked = redact({ note: 'token sk-AbCdEf012345678 leaked', list: ['ghp_ABCDEFGH012345678'] });
    expect(JSON.stringify(masked)).not.toMatch(/sk-AbCdEf012345678/);
    expect(JSON.stringify(masked)).not.toMatch(/ghp_ABCDEFGH012345678/);
    expect(JSON.stringify(masked)).toMatch(/«redacted»/);
  });

  it('createTraceEvent() redacts the payload before it can reach the append-only trace', () => {
    const ev = createTraceEvent({ run_id: 'r1', seq: 1, type: 'test', payload: { key: 'sk-Secret012345678abcd' } });
    expect(JSON.stringify(ev.payload)).not.toContain('sk-Secret012345678abcd');
    expect(JSON.stringify(ev.payload)).toContain('«redacted»');
  });
});

describe('STORY-TRUST.3 honesty — masking is documented as hygiene, not a wall', () => {
  it('SECRET_POLICY + 00_SECURITY_MODEL frame masking as accidental-leakage hygiene (not restricting the agent)', () => {
    const secretPolicy = fs.readFileSync(path.join(repoRoot, 'docs/policies/SECRET_POLICY.md'), 'utf8');
    const secModel = fs.readFileSync(path.join(repoRoot, 'docs/policies/00_SECURITY_MODEL.md'), 'utf8');
    for (const doc of [secretPolicy, secModel]) {
      expect(doc.toLowerCase()).toMatch(/hygiene, not a wall/);
      expect(doc.toLowerCase()).toMatch(/not[\s\S]{0,10}restrict[\s\S]{0,20}agent/);
    }
    // and it is NOT framed as a security wall / execution-side protection
    expect(secretPolicy.toLowerCase()).toMatch(/accidental.leakage|accidental leak/);
  });
});

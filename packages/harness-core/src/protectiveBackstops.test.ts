/**
 * STORY-GATE.2 — protective backstops run silently; catching a real danger still stops.
 */
import { describe, it, expect, vi } from 'vitest';
import { runProtectiveBackstop, scanForRealSecret } from './protectiveBackstops.ts';

describe('STORY-GATE.2 protective backstops', () => {
  it('force_push_pre_backup_auto_no_prompt + silent_not_removed (runner still invoked)', () => {
    const backup = vi.fn(() => 'OUTER_backup_20260622.bundle');
    const r = runProtectiveBackstop('force_push_backup', { backup });
    expect(backup).toHaveBeenCalledTimes(1); // silent ≠ removed — it RAN
    expect(r.ran).toBe(true);
    expect(r.silent).toBe(true);
    expect(r.stopped).toBe(false);
    expect(r.log).toMatch(/auto-backup/);
  });

  it('pre_promotion_checkpoint_auto (silent, continues)', () => {
    const checkpoint = vi.fn(() => 'cp-STORY-X');
    const r = runProtectiveBackstop('pre_promotion_checkpoint', { checkpoint });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(r.silent).toBe(true);
    expect(r.stopped).toBe(false);
  });

  it('pre_sync_fresh_clone_verify_and_secret_scan_auto + backstops_run_log_and_continue_silently', () => {
    const verify = vi.fn(() => ({ ok: true, output: 'diff: README.md +1 line, no secrets here' }));
    const r = runProtectiveBackstop('pre_sync_verify', { verify });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(r.ran).toBe(true);
    expect(r.silent).toBe(true);
    expect(r.stopped).toBe(false);    // clean → continue silently
    expect(r.log).toMatch(/clean.*continue/);
  });

  it('secret_scan_finding_real_key_still_stops_data_safety_guardrail', () => {
    // a realistic key shape about to be pushed → the backstop CATCHES it → stop
    const realKey = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2'; // 24-char body, no FAKE markers
    const verify = vi.fn(() => ({ ok: true, output: `+ const KEY = "${realKey}"` }));
    const r = runProtectiveBackstop('pre_sync_verify', { verify });
    expect(verify).toHaveBeenCalledTimes(1); // it still RAN (silent)
    expect(r.stopped).toBe(true);            // …and CAUGHT the danger → stop
    expect(r.reason).toMatch(/real secret/);
    expect(r.log).not.toContain(realKey);    // never logs the full value
  });

  it('verify failure also stops', () => {
    const r = runProtectiveBackstop('pre_sync_verify', { verify: () => ({ ok: false }) });
    expect(r.stopped).toBe(true);
    expect(r.reason).toMatch(/verify failed/);
  });

  it('scanForRealSecret ignores obvious fakes/redaction fixtures, catches real shapes', () => {
    expect(scanForRealSecret('sk-FAKE-035-4-PROOF-DO-NOT-USE-0000000000').found).toBe(false); // fixture
    expect(scanForRealSecret('value is [REDACTED]').found).toBe(false);
    expect(scanForRealSecret('AKIA' + 'ABCDEFGHIJKLMNOP').found).toBe(true);   // real AWS shape
    expect(scanForRealSecret('-----BEGIN RSA PRIVATE KEY-----').found).toBe(true);
    expect(scanForRealSecret('just normal text, no keys').found).toBe(false);
  });
});

// ── STORY-TRUST.3: the two hygiene defaults stay functional + labelled "hygiene, not a wall" ──
import fsT3 from 'node:fs';
import pathT3 from 'node:path';
import { fileURLToPath as f3 } from 'node:url';

describe('STORY-TRUST.3 hygiene defaults (force-push backup + secret masking)', () => {
  it('force_push_pre_backup_stays_functional', () => {
    let called = 0;
    const r = runProtectiveBackstop('force_push_backup', { backup: () => { called++; return 'OUTER_backup.bundle'; } });
    expect(called).toBe(1);                 // the backup STILL runs (kept functional)
    expect(r.ran).toBe(true);
    expect(r.stopped).toBe(false);          // hygiene runs silently, doesn't gate the decision
  });

  it('trace_log_secret_masking_stays_functional (the pre-push scan still catches a real key, ignores fakes)', () => {
    expect(scanForRealSecret('sk-' + 'realKey1234567890abcd').found).toBe(true);     // catches a real shape
    expect(scanForRealSecret('sk-FAKE-DO-NOT-USE-0000').found).toBe(false);          // ignores a fixture
  });

  it('both_labelled_hygiene_not_a_wall + secret_masking_framed_as_accidental_leakage_not_restricting_agent', () => {
    const src = fsT3.readFileSync(f3(new URL('./protectiveBackstops.ts', import.meta.url)), 'utf8');
    expect(src.toLowerCase()).toMatch(/hygiene, not a (security )?wall/);   // labelled hygiene-not-a-wall
    expect(src.toLowerCase()).toMatch(/accidental leak|prevents an accidental/); // accidental-leakage framing
    expect(src.toLowerCase()).toMatch(/not[\s\S]{0,10}restrict[\s\S]{0,20}agent/); // not restricting the agent
  });

  it('neither_documented_as_a_security_wall (SECRET_POLICY + 00_SECURITY_MODEL say hygiene-not-a-wall)', () => {
    const repoRoot = f3(new URL('../../../', import.meta.url));
    const secretPolicy = fsT3.readFileSync(pathT3.join(repoRoot, 'docs/policies/SECRET_POLICY.md'), 'utf8');
    const secModel = fsT3.readFileSync(pathT3.join(repoRoot, 'docs/policies/00_SECURITY_MODEL.md'), 'utf8');
    for (const doc of [secretPolicy, secModel]) {
      expect(doc).toMatch(/ADR-0013/);
      expect(doc.toLowerCase()).toMatch(/hygiene, not a wall/);
      expect(doc.toLowerCase()).toMatch(/accidental.leakage|accidental leak/);
    }
  });
});

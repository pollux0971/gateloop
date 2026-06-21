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

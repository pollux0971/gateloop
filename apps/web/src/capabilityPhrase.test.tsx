/**
 * WORK A (frontend) — the registry shows capabilities in PLAIN LANGUAGE; the operator
 * never sees raw enum strings like 'long-context'.
 */
import { describe, it, expect } from 'vitest';
import { capabilityPhrase } from './ApiPage';

describe('WORK A — capabilityPhrase is plain language (no raw enums)', () => {
  it('maps enums to human phrases', () => {
    expect(capabilityPhrase(['backend', 'debugging'])).toBe('backend logic, debugging');
    expect(capabilityPhrase(['frontend'])).toBe('frontend / UI');
    expect(capabilityPhrase(['long-context'])).toBe('whole-codebase analysis');
  });
  it('never leaks the raw enum string', () => {
    const phrase = capabilityPhrase(['long-context', 'code-generation']);
    expect(phrase).not.toMatch(/long-context/);
    expect(phrase).not.toMatch(/code-generation/);
  });
  it('empty → dash', () => {
    expect(capabilityPhrase([])).toBe('—');
    expect(capabilityPhrase(undefined)).toBe('—');
  });
});

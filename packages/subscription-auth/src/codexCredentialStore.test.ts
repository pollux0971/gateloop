import { describe, it, expect } from 'vitest';
import { ensureFreshAccess } from './codexCredentialStore';
import type { CodexOAuthCredential, CodexTokenResponse } from './codexOAuth';

const base: CodexOAuthCredential = { type: 'oauth', provider: 'codex', access: 'OLD', refresh: 'R', expires: 0, accountId: 'acct' };

describe('STORY-035.6: ensureFreshAccess — refresh-on-expiry (no network, injectable)', () => {
  it('returns the current access when not near expiry (no refresh call)', async () => {
    let called = 0;
    const r = await ensureFreshAccess({ ...base, expires: 10_000_000 }, 1_000_000, async () => { called++; return {} as CodexTokenResponse; });
    expect(r.refreshed).toBe(false);
    expect(r.access).toBe('OLD');
    expect(called).toBe(0);
  });

  it('refreshes when expired and returns the new access (token never logged here)', async () => {
    const refresh = async (rt: string): Promise<CodexTokenResponse> => {
      expect(rt).toBe('R');
      return { access_token: 'NEW', refresh_token: 'R2', expires_in: 3600 };
    };
    const r = await ensureFreshAccess(base, 1_000_000, refresh);
    expect(r.refreshed).toBe(true);
    expect(r.access).toBe('NEW');
    expect(r.credential.refresh).toBe('R2');
    expect(r.credential.expires).toBe(1_000_000 + 3_600_000);
  });

  it('preserves the prior accountId and refresh token when the refresh response omits them', async () => {
    const refresh = async (): Promise<CodexTokenResponse> => ({ access_token: 'NEW', refresh_token: '', expires_in: 3600 });
    const r = await ensureFreshAccess(base, 1_000_000, refresh);
    expect(r.accountId).toBe('acct');
    expect(r.credential.refresh).toBe('R'); // kept the old refresh token
  });

  it('refreshes within the safety skew window (before hard expiry)', async () => {
    let called = 0;
    const r = await ensureFreshAccess({ ...base, expires: 1_030_000 }, 1_000_000, async () => { called++; return { access_token: 'NEW', refresh_token: 'R2', expires_in: 3600 }; }, 60_000);
    expect(called).toBe(1); // expires in 30s < 60s skew → refreshed
    expect(r.access).toBe('NEW');
  });
});

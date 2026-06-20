import { describe, it, expect } from 'vitest';
import {
  generatePKCE,
  randomState,
  buildAuthorizeUrl,
  extractAccountId,
  toStoredCredential,
  defaultRedirectUri,
  base64UrlEncode,
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
  type CodexTokenResponse,
} from './index';

describe('STORY-035.6 (login): Codex OAuth — pure PKCE + URL building (no network, zero cost)', () => {
  it('generates a valid PKCE pair (verifier 43 chars, S256 challenge base64url)', async () => {
    const p = await generatePKCE();
    expect(p.verifier).toHaveLength(43);
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(p.challenge).not.toContain('=');
  });

  it('builds an authorize URL with the public client, PKCE S256, and offline scope', async () => {
    const pkce = await generatePKCE();
    const state = randomState();
    const url = new URL(buildAuthorizeUrl({ redirectUri: defaultRedirectUri(), pkce, state }));
    expect(url.origin + url.pathname).toBe(`${CODEX_ISSUER}/oauth/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CODEX_CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('state')).toBe(state);
  });

  it('extracts the ChatGPT account id from a JWT id_token claim', () => {
    const claims = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ chatgpt_account_id: 'acct_123' })).buffer);
    const tokens: CodexTokenResponse = { id_token: `h.${claims}.s`, access_token: 'a', refresh_token: 'r' };
    expect(extractAccountId(tokens)).toBe('acct_123');
  });

  it('builds the stored credential with an absolute expiry (caller stamps now)', () => {
    const tokens: CodexTokenResponse = { access_token: 'A', refresh_token: 'R', expires_in: 3600 };
    const cred = toStoredCredential(tokens, 1_000_000);
    expect(cred).toMatchObject({ type: 'oauth', provider: 'codex', access: 'A', refresh: 'R', expires: 1_000_000 + 3_600_000 });
  });

  it('state values are unique per call (CSRF protection)', () => {
    expect(randomState()).not.toBe(randomState());
  });
});

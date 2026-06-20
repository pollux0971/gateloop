/**
 * @gateloop/subscription-auth — Codex / ChatGPT subscription OAuth (EPIC-035 / STORY-035.6,
 * pulled forward at the operator's request). Ported from opencode (MIT) per ADR-020:
 * a public-client PKCE (S256) OAuth2 flow against auth.openai.com — NO client secret.
 *
 * ⚠️ ToS-GREY (ADR-020 §6.1): this reuses a Codex OAuth client_id and an undocumented endpoint.
 * It is an unofficial, bring-your-own-credential integration; the operator owns the risk. The
 * endorsed default remains a metered API key (035.5 core). Login itself spends nothing; only the
 * later model calls (against the subscription endpoint) are billed to the operator's plan.
 *
 * This module is PURE (no server, no storage) — it builds the PKCE params + authorize URL and
 * does the token exchange/refresh via plain fetch. The login runner (scripts/gateloop-login-codex)
 * wires the callback server and stores the token via the Secret Broker (never printed).
 */

/** OpenAI's public OAuth client for the Codex CLI flow (reused; see ToS note above). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_SCOPE = 'openid profile email offline_access';
/** The subscription model endpoint (used by the driver in 035.6, not by login). */
export const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

export interface Pkce {
  verifier: string;
  challenge: string;
}

export interface CodexTokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

/** The broker-stored credential shape (matches opencode's oauth Auth.Info). */
export interface CodexOAuthCredential {
  type: 'oauth';
  provider: 'codex';
  access: string;
  refresh: string;
  /** Absolute epoch ms when `access` expires. */
  expires: number;
  accountId?: string;
}

export function base64UrlEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64url');
}

/** Generate a PKCE verifier + S256 challenge (verifier must be retained to exchange the code). */
export async function generatePKCE(): Promise<Pkce> {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (b) => chars[b % chars.length]).join('');
  const challenge = base64UrlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** A random opaque state value for CSRF protection of the callback. */
export function randomState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

export interface AuthorizeUrlOptions {
  redirectUri: string;
  pkce: Pkce;
  state: string;
  originator?: string;
}

/** Build the OAuth authorize URL the operator opens in a browser to log in. */
export function buildAuthorizeUrl(opts: AuthorizeUrlOptions): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: opts.redirectUri,
    scope: CODEX_SCOPE,
    code_challenge: opts.pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: opts.state,
    originator: opts.originator ?? 'opencode',
  });
  return `${CODEX_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function postToken(body: URLSearchParams): Promise<CodexTokenResponse> {
  const res = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  return (await res.json()) as CodexTokenResponse;
}

/** Exchange the authorization code (from the callback) for tokens. */
export function exchangeCode(code: string, redirectUri: string, pkce: Pkce): Promise<CodexTokenResponse> {
  return postToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: pkce.verifier,
  }));
}

/** Refresh an expired access token (public-client refresh; no secret). */
export function refreshToken(refresh: string): Promise<CodexTokenResponse> {
  return postToken(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: CODEX_CLIENT_ID,
  }));
}

interface JwtClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
}

function decodeClaims(token?: string): JwtClaims | undefined {
  const part = token?.split('.')[1];
  if (!part) return undefined;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString()) as JwtClaims; } catch { return undefined; }
}

/** Extract the ChatGPT account id from the id/access token JWT (sent as a header on model calls). */
export function extractAccountId(tokens: CodexTokenResponse): string | undefined {
  const c = decodeClaims(tokens.id_token) ?? decodeClaims(tokens.access_token);
  return c?.chatgpt_account_id ?? c?.['https://api.openai.com/auth']?.chatgpt_account_id ?? c?.organizations?.[0]?.id;
}

/** Build the broker-stored credential from a token response (stamp `now` from the caller). */
export function toStoredCredential(tokens: CodexTokenResponse, now: number): CodexOAuthCredential {
  const accountId = extractAccountId(tokens);
  return {
    type: 'oauth',
    provider: 'codex',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId ? { accountId } : {}),
  };
}

export const CODEX_REDIRECT_PATH = '/auth/callback';
export function defaultRedirectUri(port: number = CODEX_CALLBACK_PORT): string {
  return `http://localhost:${port}${CODEX_REDIRECT_PATH}`;
}

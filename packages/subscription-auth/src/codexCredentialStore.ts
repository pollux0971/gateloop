/**
 * Codex credential store + access resolution (EPIC-035 / STORY-035.6).
 *
 * Reads the broker-stored Codex OAuth credential (~/.gateloop/codex-auth.json, mode 0600) and
 * resolves a FRESH access token, auto-refreshing (public-client refresh) when the access has
 * expired. The token value stays in-process and is NEVER returned to a logger — callers inject it
 * straight into the request header (the custom fetch) and redact it from any trace. Refresh is
 * injectable so the expiry logic is unit-tested with NO network, zero cost.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { refreshToken, toStoredCredential, type CodexOAuthCredential, type CodexTokenResponse } from './codexOAuth';

export const CODEX_STORE_PATH = path.join(os.homedir(), '.gateloop', 'codex-auth.json');

export function readCodexCredential(storePath: string = CODEX_STORE_PATH): CodexOAuthCredential {
  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as CodexOAuthCredential;
  if (raw.type !== 'oauth' || !raw.refresh) throw new Error(`invalid Codex credential at ${storePath} (run gateloop-login-codex)`);
  return raw;
}

export function saveCodexCredential(cred: CodexOAuthCredential, storePath: string = CODEX_STORE_PATH): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(storePath, JSON.stringify(cred, null, 2), { mode: 0o600 });
  fs.chmodSync(storePath, 0o600);
}

export interface FreshAccess {
  credential: CodexOAuthCredential;
  access: string;
  accountId?: string;
  refreshed: boolean;
}

/**
 * Ensure a non-expired access token, refreshing if within `skewMs` of expiry. Pure logic with an
 * injectable `refresh` (defaults to the real public-client refresh). Returns the (possibly new)
 * credential so the caller can persist it. Never logs the token.
 */
export async function ensureFreshAccess(
  cred: CodexOAuthCredential,
  now: number,
  refresh: (refreshToken: string) => Promise<CodexTokenResponse> = refreshToken,
  skewMs = 60_000,
): Promise<FreshAccess> {
  if (cred.access && cred.expires > now + skewMs) {
    return { credential: cred, access: cred.access, accountId: cred.accountId, refreshed: false };
  }
  const tokens = await refresh(cred.refresh);
  const next = toStoredCredential(tokens, now);
  if (!next.accountId && cred.accountId) next.accountId = cred.accountId;
  // a refresh response may omit a new refresh token — keep the prior one if so.
  if (!tokens.refresh_token && cred.refresh) next.refresh = cred.refresh;
  return { credential: next, access: next.access, accountId: next.accountId, refreshed: true };
}

export interface RefreshRoundTripResult {
  ok: boolean;
  /** A NON-SECRET summary — token values are never included. */
  access_changed: boolean;
  access_len: number;
  refresh_rotated: boolean;
  expires_in_min: number;
  accountId_present: boolean;
}

/**
 * Force a real refresh round-trip against the OAuth endpoint and persist the new credential
 * (mode-0600). Proves headless sustainability — an expired access can be renewed without a human
 * re-login. Returns ONLY a non-secret summary; the token values are never returned or logged. The
 * prior refresh token is preserved if the response omits a new one (never lock the operator out).
 */
export async function forceRefreshRoundTrip(
  storePath: string = CODEX_STORE_PATH,
  now: number = Date.now(),
  refresh: (refreshToken: string) => Promise<CodexTokenResponse> = refreshToken,
): Promise<RefreshRoundTripResult> {
  const before = readCodexCredential(storePath);
  // Force the refresh path regardless of current expiry by treating the token as already expired.
  const fresh = await ensureFreshAccess({ ...before, expires: 0 }, now, refresh);
  saveCodexCredential(fresh.credential, storePath);
  return {
    ok: Boolean(fresh.access) && fresh.refreshed,
    access_changed: fresh.access !== before.access,
    access_len: fresh.access.length,
    refresh_rotated: fresh.credential.refresh !== before.refresh,
    expires_in_min: Math.round((fresh.credential.expires - now) / 60000),
    accountId_present: Boolean(fresh.accountId),
  };
}

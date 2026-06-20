/**
 * @gateloop/subscription-auth — OPTIONAL, detachable subscription auth (EPIC-035 / STORY-035.6).
 * The metered-key core (035.2–035.5) does NOT depend on this package. ToS-grey; BYO-credential.
 */
export {
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
  CODEX_CALLBACK_PORT,
  CODEX_SCOPE,
  CODEX_API_ENDPOINT,
  CODEX_REDIRECT_PATH,
  generatePKCE,
  randomState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshToken,
  extractAccountId,
  toStoredCredential,
  base64UrlEncode,
  defaultRedirectUri,
  type Pkce,
  type CodexTokenResponse,
  type CodexOAuthCredential,
  type AuthorizeUrlOptions,
} from './codexOAuth';

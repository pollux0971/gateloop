/**
 * Codex subscription fetch (EPIC-035 / STORY-035.6) — the self-contained egress half of the
 * DETACHABLE subscription plugin. A `fetch`-shaped function that, on every request:
 *   1. resolves a FRESH access token from the broker-stored credential (auto-refresh on expiry),
 *   2. injects `Authorization: Bearer <access>` + `ChatGPT-Account-Id`,
 *   3. rewrites the model URL to the subscription endpoint (chatgpt.com/backend-api/codex/...).
 *
 * Pure Node `fetch` — NO Vercel AI SDK import (so subscription-auth stays a leaf package the core
 * never depends on; the AI-SDK glue lives in the run script). The token value flows only into the
 * request header and is NEVER returned or logged; a rotated refresh token is written back mode-0600.
 */
import { ensureFreshAccess } from './codexCredentialStore';
import { readCodexCredential, saveCodexCredential, CODEX_STORE_PATH } from './codexCredentialStore';
import { CODEX_API_ENDPOINT, type CodexOAuthCredential } from './codexOAuth';

export interface CodexFetchOptions {
  storePath?: string;
  /** Injected for tests (defaults to the global fetch). */
  baseFetch?: typeof fetch;
  /** Injected clock for tests. */
  now?: () => number;
  /** Persist a rotated credential (defaults to writing the mode-0600 store). */
  persist?: (cred: CodexOAuthCredential) => void;
}

/** Build the subscription `fetch`. The credential is read once and refreshed in-place on expiry. */
export function createCodexFetch(opts: CodexFetchOptions = {}): typeof fetch {
  const storePath = opts.storePath ?? CODEX_STORE_PATH;
  const baseFetch = opts.baseFetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const persist = opts.persist ?? ((c: CodexOAuthCredential) => saveCodexCredential(c, storePath));
  let cred = readCodexCredential(storePath);

  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const fresh = await ensureFreshAccess(cred, now());
    if (fresh.refreshed) { cred = fresh.credential; persist(cred); }
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    headers.set('authorization', `Bearer ${fresh.access}`);
    if (fresh.accountId) headers.set('chatgpt-account-id', fresh.accountId);
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const u = new URL(raw);
    const target = u.pathname.includes('/responses') || u.pathname.includes('/chat/completions') ? CODEX_API_ENDPOINT : raw;
    return baseFetch(target, { ...init, headers });
  }) as typeof fetch;
}

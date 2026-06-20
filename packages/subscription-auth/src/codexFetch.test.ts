import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCodexFetch } from './codexFetch';
import { warnSubscriptionToS, resetSubscriptionToSWarning, SUBSCRIPTION_TOS_WARNING } from './tosWarning';

let storePath: string;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fetch-'));
  storePath = path.join(dir, 'codex-auth.json');
  fs.writeFileSync(storePath, JSON.stringify({ type: 'oauth', provider: 'codex', access: 'ACCESS-123', refresh: 'R', expires: 9_999_999_999_999, accountId: 'acct-9' }), { mode: 0o600 });
});
afterEach(() => fs.rmSync(path.dirname(storePath), { recursive: true, force: true }));

describe('STORY-035.6: createCodexFetch — Bearer inject + account-id + endpoint rewrite (no network)', () => {
  it('injects the subscription token and rewrites /responses to the codex endpoint', async () => {
    const calls: { url: string; auth: string | null; account: string | null }[] = [];
    const baseFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers as HeadersInit);
      calls.push({ url: String(url), auth: h.get('authorization'), account: h.get('chatgpt-account-id') });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const f = createCodexFetch({ storePath, baseFetch });
    await f('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: 'Bearer LEAK-OLD' } });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses'); // rewritten
    expect(calls[0].auth).toBe('Bearer ACCESS-123'); // our token, the old header was stripped
    expect(calls[0].account).toBe('acct-9');
  });

  it('does NOT rewrite a non-model URL (e.g. an oauth call passes through)', async () => {
    let seen = '';
    const baseFetch = (async (url: RequestInfo | URL) => { seen = String(url); return new Response('{}'); }) as typeof fetch;
    const f = createCodexFetch({ storePath, baseFetch });
    await f('https://auth.openai.com/oauth/token');
    expect(seen).toBe('https://auth.openai.com/oauth/token');
  });
});

describe('STORY-035.6: one-time ToS warning', () => {
  beforeEach(() => resetSubscriptionToSWarning());
  it('prints once per process and names the metered-key default', () => {
    const out: string[] = [];
    expect(warnSubscriptionToS((s) => out.push(s))).toBe(true);
    expect(warnSubscriptionToS((s) => out.push(s))).toBe(false); // already warned
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('metered API key');
    expect(SUBSCRIPTION_TOS_WARNING).toMatch(/ToS-GREY/);
  });
});

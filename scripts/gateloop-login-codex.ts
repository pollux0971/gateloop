/**
 * gateloop login (Codex / ChatGPT subscription) — EPIC-035 / STORY-035.6 (operator-driven login).
 *
 * Starts the public-client PKCE OAuth flow against auth.openai.com, prints the authorize URL for
 * the operator to open in a browser, runs a localhost:1455 callback server, exchanges the code for
 * tokens, and stores them at ~/.gateloop/codex-auth.json (mode 0600). The token value is NEVER
 * printed. Login spends nothing; only later model calls (035.6 driver) are billed to the plan.
 *
 * ⚠️ ToS-GREY (ADR-020 §6.1): reuses a Codex OAuth client_id; unofficial; operator owns the risk.
 *
 * Run (foreground or background):
 *   node --experimental-strip-types scripts/gateloop-login-codex.ts
 */
import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generatePKCE,
  randomState,
  buildAuthorizeUrl,
  exchangeCode,
  toStoredCredential,
  defaultRedirectUri,
  CODEX_CALLBACK_PORT,
  CODEX_REDIRECT_PATH,
} from '../packages/subscription-auth/src/codexOAuth.ts';

const STORE_DIR = path.join(os.homedir(), '.gateloop');
const STORE_PATH = path.join(STORE_DIR, 'codex-auth.json');
const TIMEOUT_MS = 5 * 60 * 1000;

function storeCredential(cred: unknown): void {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STORE_PATH, JSON.stringify(cred, null, 2), { mode: 0o600 });
  fs.chmodSync(STORE_PATH, 0o600);
}

const SUCCESS_HTML = '<!doctype html><meta charset=utf-8><title>GateLoop</title><h1>Login successful</h1><p>You can close this window and return to GateLoop.</p>';
const errHtml = (m: string) => `<!doctype html><meta charset=utf-8><title>GateLoop</title><h1>Login failed</h1><p>${m.replace(/[&<>"']/g, '')}</p>`;

async function main(): Promise<void> {
  const pkce = await generatePKCE();
  const state = randomState();
  const redirectUri = defaultRedirectUri();
  const authorizeUrl = buildAuthorizeUrl({ redirectUri, pkce, state });

  let done = false;
  const finish = (code: number) => { setTimeout(() => process.exit(code), 200); };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${CODEX_CALLBACK_PORT}`);
    if (url.pathname !== CODEX_REDIRECT_PATH) { res.writeHead(404).end('not found'); return; }
    const err = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (err) { res.writeHead(400, { 'Content-Type': 'text/html' }).end(errHtml(err)); console.error(`LOGIN_FAILED: ${err}`); finish(1); return; }
    if (!code || url.searchParams.get('state') !== state) {
      const m = code ? 'invalid OAuth state' : 'missing authorization code';
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(errHtml(m)); console.error(`LOGIN_FAILED: ${m}`); finish(1); return;
    }
    done = true;
    exchangeCode(code, redirectUri, pkce)
      .then((tokens) => {
        storeCredential(toStoredCredential(tokens, Date.now()));
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(SUCCESS_HTML);
        // The token value is NEVER printed — only the fact + where it landed.
        console.log(`LOGIN_OK: Codex subscription credential stored at ${STORE_PATH} (mode 0600). Token not printed.`);
        finish(0);
      })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'text/html' }).end(errHtml('token exchange failed'));
        console.error(`LOGIN_FAILED: token exchange error: ${(e as Error).message}`);
        finish(1);
      });
  });

  server.on('error', (e) => { console.error(`LOGIN_FAILED: callback server error: ${(e as Error).message}`); process.exit(1); });
  server.listen(CODEX_CALLBACK_PORT, 'localhost', () => {
    console.log('=== GateLoop Codex (ChatGPT subscription) login ===');
    console.log('Open this URL in your browser and log in with your ChatGPT account:');
    console.log('');
    console.log(`AUTHORIZE_URL: ${authorizeUrl}`);
    console.log('');
    console.log(`Waiting for the browser callback on ${redirectUri} (timeout ${TIMEOUT_MS / 1000}s)…`);
    console.log('Note (ADR-020): unofficial/ToS-grey client reuse; you own the risk. The token is stored mode-0600 and never printed.');
  });

  setTimeout(() => { if (!done) { console.error('LOGIN_FAILED: timed out waiting for the browser callback.'); process.exit(1); } }, TIMEOUT_MS);
}

main().catch((e) => { console.error(`LOGIN_FAILED: ${(e as Error).message}`); process.exit(1); });

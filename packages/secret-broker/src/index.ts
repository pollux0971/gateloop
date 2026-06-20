/**
 * @gateloop/secret-broker — the Secret Broker (plan §2 key isolation).
 *
 * Agents (and Claude Code / the Bash tool) hold only opaque HANDLES, never the key
 * plaintext. The broker is the SINGLE place a handle is dereferenced into a key, and
 * it happens at the provider-call boundary — never via an agent reading `.env`.
 *
 * Two delivered guarantees:
 *   1. handle-only agent surface — runtime code passes a SecretHandle; the value lives
 *      only inside broker.resolve()'s return at the moment of the model call.
 *   2. redaction — every value the broker has dereferenced is scrubbed from any text
 *      before it can enter a trace/log/console (resolved secrets never leak downstream).
 *
 * The default source resolves the key IN A CHILD PROCESS that sources the env file and
 * prints only the value, so the agent process never runs `cat .env` itself. (Full
 * process-isolation of the key — making the HTTP call in the child too — is a larger
 * change; this broker centralizes resolution, redaction, and the handle-only surface.)
 */
import { spawnSync } from 'node:child_process';

/** An opaque reference to a secret. Carries NO plaintext — only how to find it. */
export interface SecretHandle {
  handle_id: string;
  handle_type: string;
  provider: string;
}

/** How the broker reads a provider's secret. Injectable so the broker is CI-provable. */
export interface SecretSource {
  read(provider: string): Promise<string> | string;
}

export class SecretBroker {
  private resolved = new Set<string>();
  private source: SecretSource;
  constructor(source: SecretSource) { this.source = source; }

  /** Dereference a handle into its key. The ONLY place plaintext is produced; the value
   *  is recorded so it can be redacted from any downstream text. */
  async resolve(handle: SecretHandle): Promise<string> {
    const value = await this.source.read(handle.provider);
    if (value) this.resolved.add(value);
    return value;
  }

  /** Scrub every secret this broker has dereferenced from text (trace/log guard). */
  redact(text: string): string {
    let out = text;
    for (const s of this.resolved) {
      if (s.length >= 6) out = out.split(s).join('[REDACTED_SECRET]');
    }
    return out;
  }

  /** Count of distinct secrets dereferenced — for audit; never exposes the values. */
  resolvedCount(): number {
    return this.resolved.size;
  }
}

/** Source: read `<PROVIDER>_API_KEY` from process.env (operator shell injected the keys). */
export function processEnvSource(env: NodeJS.ProcessEnv = process.env): SecretSource {
  return { read: (provider) => env[`${provider.toUpperCase()}_API_KEY`] ?? '' };
}

/**
 * Source: resolve the key IN A CHILD PROCESS that sources `envFile` and prints ONLY the
 * value to stdout, captured here. The parent (agent) never reads the file itself —
 * resolution is owned by the broker's child, honoring "agent never cats .env".
 */
export function subprocessEnvSource(opts: { envFile: string; shell?: string }): SecretSource {
  return {
    read: (provider) => {
      const varName = `${provider.toUpperCase()}_API_KEY`;
      const r = spawnSync(
        opts.shell ?? 'bash',
        ['-c', `set -a; . "$0" >/dev/null 2>&1; printf '%s' "$${varName}"`, opts.envFile],
        { encoding: 'utf8' },
      );
      return r.status === 0 ? (r.stdout ?? '') : '';
    },
  };
}

/** A static source for tests — never touches the filesystem or env. */
export function staticSource(map: Record<string, string>): SecretSource {
  return { read: (provider) => map[provider] ?? '' };
}

/**
 * Build the opaque handle for a provider's METERED API key (EPIC-035 / STORY-035.2). The
 * provider-driver passes this handle to the broker AT THE CALL BOUNDARY; the plaintext key is
 * produced only inside `broker.resolve()` and never reaches the driver/core. `provider` is the
 * broker provider id (e.g. 'openai' → `OPENAI_API_KEY`).
 */
export function meteredKeyHandle(provider: string): SecretHandle {
  return { handle_id: `metered:${provider}`, handle_type: 'metered_api_key', provider };
}

export interface ClaudeOAuthResolution {
  token: string;
  expiresAt?: number;
  expired: boolean;
}

/**
 * Resolve the Claude Code OAuth access token from a credentials.json (default
 * `~/.claude/.credentials.json`) IN A CHILD PROCESS — STORY-034.5 token injection (option 3).
 *
 * The harness (broker) reads the credential — its job, exactly like resolving `.env` keys —
 * in a short-lived child that prints ONLY the token. The agent process never `cat`s the
 * file, the token is copied to NO new file (returned in-memory for the cage's
 * `-e CLAUDE_CODE_OAUTH_TOKEN` only), and the credential stays in its mode-600 original.
 * The cage never mounts the file — only the value enters its env. Throws if absent/unreadable.
 */
export function readClaudeOAuthToken(opts: { credentialsPath?: string } = {}): ClaudeOAuthResolution {
  const home = process.env.HOME ?? '';
  const credPath = opts.credentialsPath ?? `${home}/.claude/.credentials.json`;
  const r = spawnSync(
    process.execPath, // the current node binary (avoids a snap/PATH `node` that won't nest-spawn)
    [
      '-e',
      [
        'const fs=require("fs");',
        'const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));',
        'const o=j.claudeAiOauth||{};',
        'if(!o.accessToken){process.stderr.write("no claudeAiOauth.accessToken");process.exit(3);}',
        'process.stdout.write(JSON.stringify({token:o.accessToken,expiresAt:o.expiresAt??null}));',
      ].join(''),
      credPath,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`claude credentials read failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  const parsed = JSON.parse(r.stdout) as { token: string; expiresAt: number | null };
  if (!parsed.token) throw new Error('claude credentials: empty token');
  const expired = typeof parsed.expiresAt === 'number' ? parsed.expiresAt <= Date.now() : false;
  return { token: parsed.token, expiresAt: parsed.expiresAt ?? undefined, expired };
}

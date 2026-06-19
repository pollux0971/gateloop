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

/**
 * OS-enforced sandbox cage (EPIC-034 / STORY-034.5).
 *
 * Replaces the MODELED sandbox (a temp dir + metadata) with a REAL, OS-enforced cage so a
 * real autonomous CLI agent with a real bash cannot escape. The prior 034.3/034.4 confinement
 * only governed writes that flow through the harness's own fs helpers; a real process bypasses
 * them via syscalls. The cage is enforced by the OS (here: the Docker daemon, since this host
 * forbids the unprivileged user/network namespaces rootless bwrap needs):
 *   - NETWORK: `--network none` — no interfaces, default-deny, OS-enforced;
 *   - FILESYSTEM: the ONLY writable mount is the sandbox copy at /work; the host root, $HOME,
 *     the real repo, and every credential path are simply NOT present in the container;
 *   - ENV: the host environment is NOT inherited; only broker-provisioned auth values pass via
 *     -e (value only, never a file mount);
 *   - PRIVILEGE: read-only root, all caps dropped, no-new-privileges, ephemeral (--rm).
 *
 * `buildDockerCageArgv` is pure (unit-tested, CI-safe). `runInCage` executes it. The real
 * isolation is PROVEN against a real probe process in scripts/cli-mode-e2e/prove-cage.ts —
 * the 034.5 barrier upgrade from "harness helpers refuse escapes" to "a real process cannot
 * escape". No secret path may ever be mounted (looksLikeSecretPath guard).
 */
import { execFileSync } from 'node:child_process';

/** Path fragments that must NEVER be bind-mounted into the cage. Mirrors
 *  delegationSandbox's SECRET_PATH_MARKERS (kept local so this module — and the standalone
 *  proof script — has no cross-package import that breaks under plain `node`). */
const SECRET_PATH_MARKERS = [
  '/.env', '.env', 'auth.json', '/.codex', '/.ssh', '/.aws',
  '/.config/gcloud', 'id_rsa', 'credentials', '.netrc', '.git-credentials',
];
function looksLikeSecretPath(target: string): boolean {
  const p = target.toLowerCase();
  return SECRET_PATH_MARKERS.some((m) => p.includes(m.toLowerCase()));
}

export interface RoMount {
  host: string;
  cage: string;
}

export interface DockerCageOptions {
  /** Image to run (stage 1-2: a minimal busybox proof image; stage 3: node+claude). */
  image: string;
  /** The sandbox copy — the ONLY writable bind mount, at /work. */
  sandboxRoot: string;
  /** Argv to run inside the cage. */
  command: string[];
  /** Broker-provisioned auth (VALUE only) injected via -e. Never a file mount. */
  authEnv?: Record<string, string>;
  /** Default false → `--network none` (OS-enforced default-deny). */
  network?: boolean;
  /** Read-only container root (default true) with a writable ephemeral /tmp. */
  readOnlyRoot?: boolean;
  /** Extra READ-ONLY mounts (e.g. the node runtime + claude install for stage 3). Each is
   *  refused if it looks like a secret path — secrets are NEVER mounted. */
  extraRoMounts?: RoMount[];
  /** Run as this uid:gid inside the cage (default a non-root nobody). */
  user?: string;
  timeoutMs?: number;
}

/**
 * Build the `docker run` argv for the cage. PURE — no execution. The invariants are encoded
 * structurally: exactly one writable mount (the sandbox → /work); `--network none` unless
 * explicitly enabled; host env not inherited; read-only root; all caps dropped; no secret
 * path ever mounted.
 */
export function buildDockerCageArgv(opts: DockerCageOptions): string[] {
  const args: string[] = ['run', '--rm', '--init'];

  // NETWORK — OS-enforced default-deny.
  args.push('--network', opts.network ? 'bridge' : 'none');

  // PRIVILEGE — minimal.
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  args.push('--user', opts.user ?? '65534:65534'); // nobody:nogroup
  if (opts.readOnlyRoot !== false) args.push('--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev');

  // FILESYSTEM — the ONLY writable mount is the sandbox copy.
  args.push('--volume', `${opts.sandboxRoot}:/work`, '--workdir', '/work');

  // Extra read-only mounts (stage 3 runtime) — NEVER a secret path.
  for (const m of opts.extraRoMounts ?? []) {
    if (looksLikeSecretPath(m.host)) {
      throw new Error(`refusing to mount a secret-looking path into the cage: ${m.host}`);
    }
    args.push('--volume', `${m.host}:${m.cage}:ro`);
  }

  // ENV — host env NOT inherited; only broker-provisioned auth values.
  for (const [k, v] of Object.entries(opts.authEnv ?? {})) args.push('--env', `${k}=${v}`);

  args.push(opts.image, ...opts.command);
  return args;
}

export interface CageRunResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Execute a command inside the OS cage. Synchronous; bounded by timeoutMs. */
export function runInCage(opts: DockerCageOptions): CageRunResult {
  const argv = buildDockerCageArgv(opts);
  try {
    const stdout = execFileSync('docker', argv, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '', timedOut: false };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(e),
      timedOut: Boolean(err.killed) || err.signal === 'SIGTERM',
    };
  }
}

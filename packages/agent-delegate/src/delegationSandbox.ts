/**
 * @gateloop/agent-delegate — Hardened delegation sandbox (STORY-033.3)
 *
 * The disposable, network-restricted, isolated box the external agent runs inside.
 * "Sandbox-in" of the (B) model: inside, the agent is autonomous; the safety comes
 * from the box (no host network, no secrets, read-only repo COPY, ephemeral) and
 * from the exit gate (033.6), NOT from per-action gating.
 *
 * Driver-agnostic: the same sandbox hosts the HeadlessDriver (033.2) today and the
 * AcpDriver (033.10) later. OSS prior art runs Claude Code headless in rootless
 * Podman exactly this way.
 *
 * Profile spec: configs/container_profiles.yaml (`delegation`).
 * Design: docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md
 *
 * CI-safety: this module creates real *disposable temp directories* (like
 * workspace-manager) but NEVER launches a container or touches the network. The
 * container profile is a plan, consistent with @gateloop/container-runtime's
 * dry-run philosophy. real_api_calls stays false.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DEFAULT_PROFILE, type ContainerProfile } from '@gateloop/container-runtime';
import { isPathInsideRoot } from '@gateloop/workspace-manager';
import type { SandboxHandle } from './seam-types';

// ── Network policy: default-deny + registry allowlist ────────────────────────────

export interface NetworkPolicy {
  default_action: 'deny';
  /** The ONLY hosts the agent may reach — package registries, so it can install deps. */
  allow_registries: string[];
}

/** Package registries the delegation sandbox may reach; everything else is denied. */
export const DELEGATION_ALLOW_REGISTRIES: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
] as const;

export const DELEGATION_NETWORK_POLICY: NetworkPolicy = {
  default_action: 'deny',
  allow_registries: [...DELEGATION_ALLOW_REGISTRIES],
};

/** True iff `host` is on the registry allowlist. Default-deny: unknown ⇒ false. */
export function isHostAllowed(policy: NetworkPolicy, host: string): boolean {
  return policy.allow_registries.includes(host);
}

/** Container profile for delegation — hardened default, network gated by the allowlist. */
export const DELEGATION_CONTAINER_PROFILE: ContainerProfile = {
  ...DEFAULT_PROFILE,
  // Engine sees `bridge`; an egress allowlist enforces default-deny (see NetworkPolicy).
  network: 'bridge',
};

// ── Secret-path isolation ────────────────────────────────────────────────────────

/** Path fragments that must NEVER be reachable from inside a delegation sandbox. */
const SECRET_PATH_MARKERS = [
  '/.env',
  '.env',
  'auth.json',
  '/.codex',
  '/.ssh',
  '/.aws',
  '/.config/gcloud',
  'id_rsa',
  'credentials',
  '.netrc',
  '.git-credentials',
];

/** True if a path looks like a credential/secret location. Used to assert isolation. */
export function looksLikeSecretPath(target: string): boolean {
  const p = target.toLowerCase();
  return SECRET_PATH_MARKERS.some((m) => p.includes(m.toLowerCase()));
}

/**
 * Build the env handed to the child process. The host environment is NOT inherited —
 * only the explicitly-provisioned auth vars pass through, so host secrets cannot leak
 * into the sandbox. (The broker provisions auth *values*; this module never reads a
 * credential file.) PATH is provided minimally so the CLI binary resolves.
 */
export function buildSandboxEnv(authEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const [k, v] of Object.entries(authEnv)) env[k] = v;
  return env;
}

// ── The sandbox ──────────────────────────────────────────────────────────────────

export interface DelegationSandbox {
  sandbox_id: string;
  /** Ephemeral writable working dir — the agent edits THIS copy, not the source. */
  root: string;
  /** The original repo; provided read-only (copied in), never mutated. */
  source_dir: string;
  read_only_repo_copy: true;
  ephemeral: true;
  isolated: true;
  network: NetworkPolicy;
  profile: ContainerProfile;
  created_at: string;
}

export interface CreateDelegationSandboxOptions {
  delegation_id: string;
  /** Repo whose contents are copied (read-only) into the sandbox. */
  source_dir: string;
  /** Auth env injected into the child (values only; no file reads here). */
  auth_env?: Record<string, string>;
  /** Sandbox policy hint forwarded to the driver/CLI. */
  sandbox_mode?: SandboxHandle['sandbox_mode'];
}

let _sbSeq = 0;

/**
 * Create a hardened, ephemeral, isolated delegation sandbox.
 *  - copies the source repo into a fresh disposable temp dir (read-only COPY:
 *    the agent edits the copy; the original is never written),
 *  - attaches the default-deny + registry-allowlist network policy,
 *  - scrubs the environment to auth-only.
 * No container is launched and no network is touched.
 */
export function createDelegationSandbox(opts: CreateDelegationSandboxOptions): DelegationSandbox {
  const src = path.resolve(opts.source_dir);
  if (!fs.existsSync(src)) throw new Error(`source_dir does not exist: ${src}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ch-delegate-${opts.delegation_id}-`));
  // Read-only COPY: read from source, write into the disposable sandbox root. The
  // source tree is the authority for the PRE-delegation state (033.6 diffs against it).
  copyRepo(src, root);

  return {
    sandbox_id: `sb_${opts.delegation_id}_${++_sbSeq}_${crypto.randomBytes(3).toString('hex')}`,
    root,
    source_dir: src,
    read_only_repo_copy: true,
    ephemeral: true,
    isolated: true,
    network: DELEGATION_NETWORK_POLICY,
    profile: DELEGATION_CONTAINER_PROFILE,
    created_at: new Date().toISOString(),
  };
}

/** Recursively copy a repo, skipping VCS internals and node_modules (kept lean). */
function copyRepo(srcDir: string, destDir: string): void {
  const SKIP = new Set(['.git', 'node_modules', 'dist', '.codegraph']);
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter: (s) => !SKIP.has(path.basename(s)),
  });
}

/** Map a sandbox to the SandboxHandle the HeadlessDriver consumes. */
export function sandboxHandle(sb: DelegationSandbox, opts: CreateDelegationSandboxOptions): SandboxHandle {
  return {
    cwd: sb.root,
    env: buildSandboxEnv(opts.auth_env),
    sandbox_mode: opts.sandbox_mode ?? 'workspace-write',
  };
}

/**
 * Isolation predicate: can `target` be reached from inside this sandbox? Only paths
 * INSIDE the sandbox's own root are reachable. Secret paths and any other location
 * (host, another sandbox's root) are NOT. This is the deterministic check behind the
 * `cannot_reach_secrets_or_other_sandboxes` behavior.
 */
export function sandboxCanReach(sb: DelegationSandbox, target: string): boolean {
  const abs = path.resolve(target);
  if (looksLikeSecretPath(abs)) return false;
  return isPathInsideRoot(sb.root, abs);
}

/** Ephemeral teardown — destroy the sandbox dir. Idempotent. */
export function destroyDelegationSandbox(sb: DelegationSandbox): void {
  fs.rmSync(sb.root, { recursive: true, force: true });
}

/** Read a file from the sandbox copy (containment-checked). */
export function readSandboxFile(sb: DelegationSandbox, relPath: string): string {
  const abs = path.resolve(sb.root, relPath);
  if (!isPathInsideRoot(sb.root, abs)) throw new Error('path escapes sandbox');
  return fs.readFileSync(abs, 'utf8');
}

/** Write a file into the sandbox copy (containment-checked). Simulates agent edits. */
export function writeSandboxFile(sb: DelegationSandbox, relPath: string, content: string): void {
  const abs = path.resolve(sb.root, relPath);
  if (!isPathInsideRoot(sb.root, abs)) throw new Error('path escapes sandbox');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createDelegationSandbox,
  destroyDelegationSandbox,
  sandboxCanReach,
  sandboxHandle,
  buildSandboxEnv,
  isHostAllowed,
  looksLikeSecretPath,
  readSandboxFile,
  writeSandboxFile,
  DELEGATION_NETWORK_POLICY,
  DELEGATION_ALLOW_REGISTRIES,
  DELEGATION_CONTAINER_PROFILE,
  type DelegationSandbox,
} from './delegationSandbox';

// Build a throwaway "source repo" on disk to copy into sandboxes.
function makeSourceRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-src-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.ts'), 'export const b = 2;\n');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function newSandbox(id = 'test'): { sb: DelegationSandbox; src: string } {
  const src = makeSourceRepo();
  const sb = createDelegationSandbox({ delegation_id: id, source_dir: src });
  cleanups.push(() => destroyDelegationSandbox(sb));
  cleanups.push(() => fs.rmSync(src, { recursive: true, force: true }));
  return { sb, src };
}

describe('agent-delegate / hardened delegation sandbox (STORY-033.3)', () => {
  // ── sandbox_is_ephemeral_and_isolated ──
  it('sandbox_is_ephemeral_and_isolated', () => {
    const { sb } = newSandbox();
    expect(sb.ephemeral).toBe(true);
    expect(sb.isolated).toBe(true);
    expect(fs.existsSync(sb.root)).toBe(true);
    // two sandboxes get distinct roots + ids (isolation)
    const { sb: sb2 } = newSandbox('other');
    expect(sb2.root).not.toBe(sb.root);
    expect(sb2.sandbox_id).not.toBe(sb.sandbox_id);
    // ephemeral teardown removes the dir
    destroyDelegationSandbox(sb);
    expect(fs.existsSync(sb.root)).toBe(false);
    // idempotent
    expect(() => destroyDelegationSandbox(sb)).not.toThrow();
  });

  // ── network_default_deny_allowlist_registries ──
  it('network_default_deny_allowlist_registries', () => {
    expect(DELEGATION_NETWORK_POLICY.default_action).toBe('deny');
    expect(DELEGATION_NETWORK_POLICY.allow_registries).toEqual([...DELEGATION_ALLOW_REGISTRIES]);
    // registries reachable
    expect(isHostAllowed(DELEGATION_NETWORK_POLICY, 'registry.npmjs.org')).toBe(true);
    expect(isHostAllowed(DELEGATION_NETWORK_POLICY, 'pypi.org')).toBe(true);
    // everything else denied (default-deny)
    expect(isHostAllowed(DELEGATION_NETWORK_POLICY, 'api.anthropic.com')).toBe(false);
    expect(isHostAllowed(DELEGATION_NETWORK_POLICY, 'evil.example.com')).toBe(false);
    expect(isHostAllowed(DELEGATION_NETWORK_POLICY, '169.254.169.254')).toBe(false);
    // the sandbox carries this policy + hardened profile
    const { sb } = newSandbox();
    expect(sb.network).toEqual(DELEGATION_NETWORK_POLICY);
    expect(sb.profile).toEqual(DELEGATION_CONTAINER_PROFILE);
    expect(DELEGATION_CONTAINER_PROFILE.cap_drop).toContain('ALL');
    expect(DELEGATION_CONTAINER_PROFILE.no_new_privileges).toBe(true);
  });

  // ── repo_mounted_read_only_copy ──
  it('repo_mounted_read_only_copy: source is copied and never mutated by sandbox edits', () => {
    const { sb, src } = newSandbox();
    expect(sb.read_only_repo_copy).toBe(true);
    // the copy contains the repo files
    expect(readSandboxFile(sb, 'a.ts')).toContain('export const a = 1;');
    expect(readSandboxFile(sb, 'sub/b.ts')).toContain('export const b = 2;');
    // .git is NOT copied (lean copy)
    expect(fs.existsSync(path.join(sb.root, '.git'))).toBe(false);
    // the agent edits the COPY…
    writeSandboxFile(sb, 'a.ts', 'export const a = 999;');
    expect(readSandboxFile(sb, 'a.ts')).toContain('999');
    // …and the SOURCE is untouched (read-only copy semantics)
    expect(fs.readFileSync(path.join(src, 'a.ts'), 'utf8')).toContain('export const a = 1;');
  });

  // ── cannot_reach_secrets_or_other_sandboxes ──
  it('cannot_reach_secrets_or_other_sandboxes', () => {
    const { sb } = newSandbox('a');
    const { sb: sbOther } = newSandbox('b');

    // its own files are reachable
    expect(sandboxCanReach(sb, path.join(sb.root, 'a.ts'))).toBe(true);

    // another sandbox's root is NOT reachable
    expect(sandboxCanReach(sb, path.join(sbOther.root, 'a.ts'))).toBe(false);

    // secret paths are NOT reachable, even if phrased inside the root
    expect(sandboxCanReach(sb, path.join(sb.root, '.env'))).toBe(false);
    expect(sandboxCanReach(sb, '/home/user/.ssh/id_rsa')).toBe(false);
    expect(sandboxCanReach(sb, '/home/user/.codex/auth.json')).toBe(false);
    expect(looksLikeSecretPath('/x/.aws/credentials')).toBe(true);
    expect(looksLikeSecretPath('/x/src/index.ts')).toBe(false);

    // host paths outside the sandbox are NOT reachable
    expect(sandboxCanReach(sb, '/etc/passwd')).toBe(false);
  });

  it('buildSandboxEnv injects only auth vars — host secrets are not inherited', () => {
    const env = buildSandboxEnv({ ANTHROPIC_API_KEY: 'handle://x' });
    expect(env.ANTHROPIC_API_KEY).toBe('handle://x');
    expect(env.PATH).toBeTruthy();
    // nothing else from the host env bled in
    const keys = Object.keys(env).sort();
    expect(keys).toEqual(['ANTHROPIC_API_KEY', 'PATH']);
  });

  it('sandboxHandle maps to the driver SandboxHandle shape', () => {
    const src = makeSourceRepo();
    cleanups.push(() => fs.rmSync(src, { recursive: true, force: true }));
    const opts = { delegation_id: 'h', source_dir: src, auth_env: { CODEX_HOME: '/broker/codex' }, sandbox_mode: 'workspace-write' as const };
    const sb = createDelegationSandbox(opts);
    cleanups.push(() => destroyDelegationSandbox(sb));
    const handle = sandboxHandle(sb, opts);
    expect(handle.cwd).toBe(sb.root);
    expect(handle.env?.CODEX_HOME).toBe('/broker/codex');
    expect(handle.sandbox_mode).toBe('workspace-write');
  });

  it('rejects a non-existent source_dir', () => {
    expect(() => createDelegationSandbox({ delegation_id: 'x', source_dir: '/no/such/dir/xyz' })).toThrow();
  });
});

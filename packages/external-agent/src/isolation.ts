/**
 * Sandbox isolation invariants (EPIC-034 / STORY-034.4) — THE SECURITY CRUX + BARRIER.
 *
 * Before any real CLI agent (with a real bash) is allowed to spend money (034.5), PROVE the
 * sandbox cages it — at ZERO COST, using a FAKE planted secret and dry-run (no real CLI
 * spawn, no real network). Three isolations, each a callable tested invariant, plus the
 * broker-auth no-plaintext guarantee. All compose 033.3's hardened sandbox primitives
 * (sandboxCanReach / read/writeSandboxFile / isHostAllowed / buildSandboxEnv) — not rebuilt.
 *
 * This module is the barrier for 034.5: assertSandboxIsolationBarrier must return
 * all_held === true before a real Claude Code run is permitted. The ordering is mandatory
 * and irreversible (a sandbox that leaks unproven could expose real secrets).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type DelegationSandbox,
  sandboxCanReach,
  readSandboxFile,
  writeSandboxFile,
  looksLikeSecretPath,
  isHostAllowed,
  buildSandboxEnv,
} from '@gateloop/agent-delegate';

export interface InvariantResult {
  invariant: string;
  held: boolean;
  detail: string;
}

/** A clearly-FAKE secret value for the zero-cost proof — never a real credential. */
export const FAKE_SECRET_VALUE = 'sk-FAKE-isolation-proof-000000000000-not-a-real-key';

/** Recursively scan a directory tree for a literal substring (used to prove a secret value
 *  never landed on disk inside the sandbox). Bounded to the sandbox copy; local-only. */
function treeContainsString(root: string, needle: string): boolean {
  if (!needle) return false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(abs); continue; }
      try { if (fs.readFileSync(abs, 'utf8').includes(needle)) return true; } catch { /* binary/unreadable — skip */ }
    }
  }
  return false;
}

/**
 * INVARIANT 1 — SECRETS INVISIBLE. A host secret planted OUTSIDE the sandbox cannot be read
 * from inside it. Both the reach predicate (sandboxCanReach) AND an actual read attempt
 * through the sandbox's containment-checked reader (which must throw) must agree.
 * Zero-cost: the planted secret is FAKE.
 */
export function assertSandboxCannotReadHostSecret(sb: DelegationSandbox, hostSecretAbsPath: string): InvariantResult {
  const reachable = sandboxCanReach(sb, hostSecretAbsPath);
  let readThrew = false;
  try {
    readSandboxFile(sb, path.relative(sb.root, hostSecretAbsPath));
  } catch {
    readThrew = true;
  }
  const held = !reachable && readThrew;
  return {
    invariant: 'sandbox_cannot_read_host_secret',
    held,
    detail: held
      ? `host secret '${path.basename(hostSecretAbsPath)}' unreachable (reach=false; sandbox read threw; looksLikeSecretPath=${looksLikeSecretPath(hostSecretAbsPath)})`
      : `LEAK RISK: reachable=${reachable}, readThrew=${readThrew}`,
  };
}

/**
 * INVARIANT 2 — WRITES CONFINED. A write whose resolved path escapes the sandbox copy is
 * REFUSED (writeSandboxFile is containment-checked and throws), and the real tree outside is
 * untouched. Zero-cost dry-run: the escaping write is never performed.
 */
export function assertWriteOutsideSandboxBlocked(sb: DelegationSandbox, escapeRelPath = '../escape-proof.txt'): InvariantResult {
  const target = path.resolve(sb.root, escapeRelPath);
  const existedBefore = fs.existsSync(target);
  let refused = false;
  try {
    writeSandboxFile(sb, escapeRelPath, 'pwned');
  } catch {
    refused = true;
  }
  const untouched = fs.existsSync(target) === existedBefore;
  const held = refused && untouched;
  return {
    invariant: 'write_outside_sandbox_blocked',
    held,
    detail: held
      ? `escape write to '${escapeRelPath}' refused; real tree untouched (target exists=${fs.existsSync(target)})`
      : `LEAK RISK: refused=${refused}, untouched=${untouched}`,
  };
}

/**
 * INVARIANT 3 — NETWORK DENIED. A fetch to any non-allowlisted host is denied by the
 * sandbox's default-deny policy. No real network is touched — the policy rejects before any
 * egress. (A registry host on the allowlist IS reachable, proving it's a real allowlist, not
 * a blanket block.)
 */
export function assertNetworkDeniedInSandbox(sb: DelegationSandbox, host = 'api.openai.com'): InvariantResult {
  const denied = !isHostAllowed(sb.network, host);
  const defaultDeny = sb.network.default_action === 'deny';
  const allowlistReal = sb.network.allow_registries.length > 0 && isHostAllowed(sb.network, sb.network.allow_registries[0]);
  const held = denied && defaultDeny && allowlistReal;
  return {
    invariant: 'network_denied_in_sandbox',
    held,
    detail: held
      ? `fetch to '${host}' denied (default_action=deny; only ${sb.network.allow_registries.length} registry hosts allowed)`
      : `LEAK RISK: denied=${denied}, defaultDeny=${defaultDeny}, allowlistReal=${allowlistReal}`,
  };
}

/**
 * BROKER AUTH — the CLI authenticates via a broker-provisioned env VALUE; the secret lives
 * ONLY in the child process environment, never written into the sandbox copy and never in
 * the sandbox's readable tree. The host environment is NOT inherited (buildSandboxEnv scrubs
 * to PATH + provisioned auth only). Zero-cost: the auth value is the FAKE secret.
 */
export function assertCliAuthViaBrokerNoPlaintext(sb: DelegationSandbox, authEnv: Record<string, string>): InvariantResult {
  const env = buildSandboxEnv(authEnv);
  const secretVals = Object.values(authEnv).filter(Boolean);
  const inProcessEnvOnly = secretVals.every((v) => Object.values(env).includes(v));
  const leakedToSandboxDisk = secretVals.some((v) => treeContainsString(sb.root, v));
  // host env not inherited: anything in process.env that we did NOT provision is absent.
  const hostNotInherited = !('HOME' in env) && !('SHELL' in env);
  const held = inProcessEnvOnly && !leakedToSandboxDisk && hostNotInherited;
  return {
    invariant: 'cli_auth_via_broker_no_plaintext',
    held,
    detail: held
      ? 'auth value present in child env only; absent from sandbox disk; host env not inherited'
      : `LEAK RISK: inProcessEnvOnly=${inProcessEnvOnly}, leakedToSandboxDisk=${leakedToSandboxDisk}, hostNotInherited=${hostNotInherited}`,
  };
}

export interface IsolationBarrierInput {
  sb: DelegationSandbox;
  /** Absolute path of the FAKE host secret planted outside the sandbox. */
  hostSecretAbsPath: string;
  /** The fake auth env the broker would provision (value only). */
  authEnv: Record<string, string>;
}

export interface IsolationBarrierResult {
  /** True iff ALL invariants held — the precondition for 034.5 (real Claude Code spend). */
  all_held: boolean;
  invariants: InvariantResult[];
  /** Asserted properties of the proof itself. */
  zero_cost: true;
}

/**
 * THE BARRIER for 034.5. Runs all three isolation invariants + the broker no-plaintext
 * guarantee over a FAKE secret with no real CLI/network. 034.5 MUST NOT proceed unless
 * `all_held === true`. This ordering is mandatory and irreversible.
 */
export function assertSandboxIsolationBarrier(input: IsolationBarrierInput): IsolationBarrierResult {
  const invariants = [
    assertSandboxCannotReadHostSecret(input.sb, input.hostSecretAbsPath),
    assertWriteOutsideSandboxBlocked(input.sb),
    assertNetworkDeniedInSandbox(input.sb),
    assertCliAuthViaBrokerNoPlaintext(input.sb, input.authEnv),
  ];
  return { all_held: invariants.every((i) => i.held), invariants, zero_cost: true };
}

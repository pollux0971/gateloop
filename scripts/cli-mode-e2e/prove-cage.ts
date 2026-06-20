/**
 * 034.5 isolation proof — REAL PROCESS edition (the barrier upgrade).
 *
 * 034.4 proved the harness's OWN checked-write helpers refuse escapes. That does not bind a
 * real external process, which has a real bash and bypasses those helpers. This proof runs a
 * REAL probe process (busybox shell — not Claude) INSIDE the OS cage and has it actually
 * ATTEMPT to escape, asserting every attempt fails. It upgrades the four invariants from
 * "our helpers refuse" to "a real confined process cannot escape".
 *
 * ZERO COST: a static busybox probe, a FAKE secret, no Claude spawn, no real network egress
 * (the network attempt is expected to fail under `--network none`). Run:
 *   node scripts/cli-mode-e2e/prove-cage.ts      (exit 0 = all four invariants held)
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDockerCageArgv, runInCage } from '../../packages/external-agent/src/osCage.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = 'cage-probe:latest';
const FAKE_KEY = 'sk-FAKE-cage-proof-000000000000-not-a-real-key';

// Ensure the OFFLINE cage image exists (no network pull).
execFileSync('bash', [path.join(here, 'build-cage-image.sh'), IMAGE], { stdio: 'inherit' });

// A real sandbox copy (the only writable mount) + a FAKE host secret planted OUTSIDE it.
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cage-sandbox-'));
fs.writeFileSync(path.join(sandboxRoot, 'README.md'), '# pre-delegation tree\n');
const hostSecretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cage-host-secret-'));
const hostSecretPath = path.join(hostSecretDir, '.env');
fs.writeFileSync(hostSecretPath, `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

// The REAL probe: a busybox shell that actively tries to break out. Every attempt is logged.
const PROBE = `
set +e
echo "## read-host-secret"
for p in "$FAKE_HOST_SECRET" /home/pollux/.ssh/id_rsa /home/pollux/.codex/auth.json /data/python/codeharness_workspace/gateloop/.env; do
  if cat "$p" 2>/dev/null >/dev/null; then echo "LEAK_READ:$p"; else echo "OK_UNREADABLE:$p"; fi
done
echo "## write-outside-work"
for p in /escape.txt /etc/escape.txt /bin/escape.txt; do
  if echo pwned > "$p" 2>/dev/null; then echo "LEAK_WRITE:$p"; else echo "OK_NOWRITE:$p"; fi
done
echo "## write-inside-work"
if echo inside > /work/probe_inside.txt 2>/dev/null; then echo "OK_WORK_WRITE"; else echo "FAIL_WORK_WRITE"; fi
echo "## network"
if busybox nc -w 3 1.1.1.1 443 </dev/null 2>/dev/null; then echo "LEAK_NET:nc"; else echo "OK_NET_DENIED:nc"; fi
if busybox wget -T 3 -q -O - http://1.1.1.1/ 2>/dev/null >/dev/null; then echo "LEAK_NET:wget"; else echo "OK_NET_DENIED:wget"; fi
echo "## broker-env"
if [ -n "$ANTHROPIC_API_KEY" ]; then echo "OK_AUTH_PRESENT"; else echo "FAIL_NO_AUTH"; fi
echo "HOME_IS=\${HOME:-unset}"
`;

const run = runInCage({
  image: IMAGE,
  sandboxRoot,
  command: ['/bin/sh', '-c', PROBE],
  authEnv: { ANTHROPIC_API_KEY: FAKE_KEY, FAKE_HOST_SECRET: hostSecretPath },
  user: `${uid}:${gid}`,
  timeoutMs: 60_000,
});

const out = run.stdout;
console.log('\n──── probe output (inside the cage) ────\n' + out.trim() + '\n───────────────────────────────────────');

function treeContains(root: string, needle: string): boolean {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(abs); continue; }
      try { if (fs.readFileSync(abs, 'utf8').includes(needle)) return true; } catch { /* skip */ }
    }
  }
  return false;
}

// ── Assertions: the four invariants, against the REAL process ───────────────────
const results: { invariant: string; held: boolean; detail: string }[] = [];

// 1. secrets invisible — no LEAK_READ, every secret path unreadable
const leakRead = (out.match(/LEAK_READ:\S+/g) ?? []);
results.push({ invariant: 'real_process_cannot_read_host_secret', held: leakRead.length === 0,
  detail: leakRead.length === 0 ? 'all host secret paths unreadable in cage (not mounted)' : `LEAKED: ${leakRead.join(', ')}` });

// 2. writes confined — no LEAK_WRITE; /work writable; host tree outside untouched
const leakWrite = (out.match(/LEAK_WRITE:\S+/g) ?? []);
const workWrote = out.includes('OK_WORK_WRITE') && fs.existsSync(path.join(sandboxRoot, 'probe_inside.txt'));
const hostParentClean = !fs.existsSync(path.resolve(sandboxRoot, '..', 'escape.txt')) && !fs.existsSync('/escape.txt');
results.push({ invariant: 'real_process_writes_confined_host_untouched', held: leakWrite.length === 0 && workWrote && hostParentClean,
  detail: leakWrite.length === 0 && workWrote && hostParentClean ? 'outside-/work writes refused; /work write landed on host sandbox; host tree untouched' : `leakWrite=${leakWrite.join(',')} workWrote=${workWrote} hostParentClean=${hostParentClean}` });

// 3. network denied — no LEAK_NET
const leakNet = (out.match(/LEAK_NET:\S+/g) ?? []);
results.push({ invariant: 'real_process_network_denied', held: leakNet.length === 0,
  detail: leakNet.length === 0 ? 'nc + wget egress denied (--network none)' : `LEAKED: ${leakNet.join(', ')}` });

// 4. broker auth, no plaintext — auth present in cage env, key absent from sandbox disk, host env not inherited
const authPresent = out.includes('OK_AUTH_PRESENT');
const keyOnDisk = treeContains(sandboxRoot, FAKE_KEY);
const homeVal = (out.match(/HOME_IS=(\S*)/)?.[1] ?? '').trim();
const homeNotHost = (homeVal === 'unset' || homeVal === '/' || homeVal === '') && !homeVal.includes('/home/') && !homeVal.includes('pollux');
results.push({ invariant: 'broker_auth_no_plaintext_real_process', held: authPresent && !keyOnDisk && homeNotHost,
  detail: authPresent && !keyOnDisk && homeNotHost ? 'auth value present in cage env only; absent from sandbox disk; host HOME not inherited' : `authPresent=${authPresent} keyOnDisk=${keyOnDisk} homeNotHost=${homeNotHost}` });

// Cleanup.
fs.rmSync(sandboxRoot, { recursive: true, force: true });
fs.rmSync(hostSecretDir, { recursive: true, force: true });

console.log('\n──── REAL-PROCESS isolation invariants ────');
for (const r of results) console.log(`${r.held ? 'HELD ' : 'FAIL '} ${r.invariant} — ${r.detail}`);
const allHeld = results.every(r => r.held);
console.log(`\ncage argv: docker ${buildDockerCageArgv({ image: IMAGE, sandboxRoot: '<sandbox>', command: ['/bin/sh'] }).join(' ')}`);
console.log(allHeld ? '\nALL FOUR INVARIANTS HELD against a real confined process — cage is real. (zero cost)' : '\nISOLATION CRACK — do NOT run real Claude Code.');
process.exit(allHeld ? 0 : 1);

/**
 * STORY-034.5 Stage 2 — Layer-2 auto-gate: prove the cage has NO secrets (the backstop).
 *
 * Runs a REAL busybox probe inside the EXACT cage config Claude will use (cage-claude image +
 * the proxy network), and asserts the cage cannot read ANY host secret — including the real
 * `~/.claude/.credentials.json` (whose token the broker injects only as an env value). Unlike
 * the clean-cage proof, the network is intentionally proxy-allowed here, so the network-denied
 * invariant is dropped (that is Layer 1, set-and-use, not re-proven). This gate checks ONLY the
 * secret backstop: if anything leaks, ABORT — do not spawn Claude.
 *
 * Zero cost: busybox probe, FAKE injected token, no Claude, no real network (the probe makes
 * none). Exit 0 = held (spawn allowed). Run by gated-claude-run.ts before any spawn.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDockerCageArgv, runInCage } from '../../packages/external-agent/src/osCage.ts';

const IMAGE = 'cage-claude:latest';
const PROXY = 'http://host.docker.internal:8889';
const FAKE_TOKEN = 'sk-ant-oat-FAKE-layer2-gate-000000';

export function proveLayer2(): { held: boolean; results: { invariant: string; held: boolean; detail: string }[]; probe: string } {
  const home = process.env.HOME ?? '';
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'layer2-sb-'));
  fs.writeFileSync(path.join(sandboxRoot, 'README.md'), '# pre-delegation\n');
  const hostSecretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer2-host-'));
  const fakeSecret = path.join(hostSecretDir, '.env');
  fs.writeFileSync(fakeSecret, `ANTHROPIC_API_KEY=sk-FAKE-host-secret\n`);
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;

  // Real host secret paths the cage MUST NOT be able to read (incl. the credential whose token
  // the broker injects only as a value).
  const realSecrets = [
    fakeSecret,
    `${home}/.claude/.credentials.json`,
    `${home}/.ssh/id_rsa`,
    `${home}/.codex/auth.json`,
    `${process.cwd()}/gateloop/.env`,
  ];
  const PROBE = `
set +e
echo "## read-host-secret"
for p in ${realSecrets.map((s) => `"${s}"`).join(' ')}; do
  if cat "$p" 2>/dev/null >/dev/null; then echo "LEAK_READ:$p"; else echo "OK_UNREADABLE:$p"; fi
done
echo "## write-outside-work"
for p in /escape.txt /etc/escape.txt; do
  if echo x > "$p" 2>/dev/null; then echo "LEAK_WRITE:$p"; else echo "OK_NOWRITE:$p"; fi
done
if echo inside > /work/probe_inside.txt 2>/dev/null; then echo "OK_WORK_WRITE"; else echo "FAIL_WORK_WRITE"; fi
echo "## token-env"
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo "OK_TOKEN_ENV_PRESENT"; else echo "FAIL_NO_TOKEN_ENV"; fi
echo "HOME_IS=\${HOME:-unset}"
echo "## image-secret-scan"
if [ -d /home ] && [ -n "$(ls -A /home 2>/dev/null)" ]; then echo "LEAK_IMG:/home"; else echo "OK_NO_HOME_IN_IMAGE"; fi
# Credential FILES must be absent (the non-secret onboarding .claude.json is allowed).
for f in $(find / -xdev \\( -name '.credentials.json' -o -name 'auth.json' -o -name '.env' -o -name 'id_rsa' -o -name '.npmrc' -o -name '.netrc' -o -name '.git-credentials' \\) 2>/dev/null); do echo "LEAK_IMG:$f"; done
# The only baked claude config must contain NO token/credential material.
if [ -f /opt/claude-config/.claude.json ] && grep -iE 'token|sk-ant|secret|credential|accessToken|refreshToken' /opt/claude-config/.claude.json >/dev/null 2>&1; then echo "LEAK_IMG:baked-config-has-secret"; else echo "OK_BAKED_CONFIG_CLEAN"; fi
echo "OK_SCAN_DONE"
`;

  const run = runInCage({
    image: IMAGE,
    sandboxRoot,
    command: ['/bin/sh', '-c', PROBE],
    authEnv: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, // FAKE token for the gate (real one is injected at spawn)
    proxyUrl: PROXY,
    disableTelemetry: true,
    user: `${uid}:${gid}`,
    timeoutMs: 60_000,
  });
  const out = run.stdout;

  const treeContains = (root: string, needle: string): boolean => {
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
  };

  const leakRead = out.match(/LEAK_READ:\S+/g) ?? [];
  const leakWrite = out.match(/LEAK_WRITE:\S+/g) ?? [];
  const leakImg = out.match(/LEAK_IMG:\S+/g) ?? [];
  const homeVal = (out.match(/HOME_IS=(\S*)/)?.[1] ?? '').trim();
  const results = [
    { invariant: 'cage_cannot_read_any_host_secret', held: leakRead.length === 0, detail: leakRead.length === 0 ? 'fake .env + real ~/.claude/.credentials.json/~/.ssh/~/.codex/gateloop.env all unreadable' : `LEAKED: ${leakRead.join(', ')}` },
    { invariant: 'writes_confined_host_untouched', held: leakWrite.length === 0 && out.includes('OK_WORK_WRITE') && fs.existsSync(path.join(sandboxRoot, 'probe_inside.txt')), detail: leakWrite.length === 0 ? 'outside-/work refused; /work write landed' : `LEAKED: ${leakWrite.join(', ')}` },
    { invariant: 'injected_token_in_env_not_on_disk', held: out.includes('OK_TOKEN_ENV_PRESENT') && !treeContains(sandboxRoot, FAKE_TOKEN) && !homeVal.includes('/home/') && !homeVal.includes('pollux'), detail: `tokenEnv=${out.includes('OK_TOKEN_ENV_PRESENT')} onDisk=${treeContains(sandboxRoot, FAKE_TOKEN)} home=${homeVal}` },
    { invariant: 'no_home_or_secret_config_in_cage_image', held: leakImg.length === 0 && out.includes('OK_SCAN_DONE'), detail: leakImg.length === 0 ? 'no $HOME/.claude/.credentials.json/auth.json/.env/.ssh baked into the image' : `LEAKED: ${leakImg.join(', ')}` },
  ];

  fs.rmSync(sandboxRoot, { recursive: true, force: true });
  fs.rmSync(hostSecretDir, { recursive: true, force: true });
  return { held: results.every((r) => r.held), results, probe: out };
}

// CLI entry — Stage 2 standalone proof.
if (process.argv[1] && process.argv[1].endsWith('prove-layer2.ts')) {
  execFileSync('bash', [path.join(path.dirname(new URL(import.meta.url).pathname), 'build-claude-cage-image.sh'), IMAGE], { stdio: 'inherit' });
  const r = proveLayer2();
  console.log('\n──── probe output ────\n' + r.probe.trim() + '\n──────────────────────');
  console.log('\n──── Layer-2 (cage has no secrets) — REAL process in the proxied claude cage ────');
  for (const x of r.results) console.log(`${x.held ? 'HELD ' : 'FAIL '} ${x.invariant} — ${x.detail}`);
  console.log(`\ncage argv: docker ${buildDockerCageArgv({ image: IMAGE, sandboxRoot: '<sandbox>', command: ['/bin/sh'], proxyUrl: PROXY, disableTelemetry: true, passthroughEnv: ['CLAUDE_CODE_OAUTH_TOKEN'] }).join(' ')}`);
  console.log(r.held ? '\nLAYER-2 HELD — cage has no secrets. Spawn permitted. (zero cost)' : '\nLAYER-2 BREACH — do NOT spawn Claude.');
  process.exit(r.held ? 0 : 1);
}

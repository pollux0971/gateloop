/**
 * STORY-034.5 Layer-1 hardening proof — egress is ACTUALLY constrained (the must-verify).
 *
 * 034.5's lesson was "set ≠ effective": the proxy allowlist was set, but a bridge network with
 * a gateway let Claude bypass it (proxy.log empty). This proves the hardened design works:
 *   - cage on a no-gateway `--internal` network → no direct route out;
 *   - the proxy container straddles the internal net + bridge → the ONLY egress;
 *   - a REAL busybox probe (not Claude) shows: api.anthropic.com reachable VIA the proxy,
 *     every other host unreachable, the proxy IS on the path (its log is NOT empty), and direct
 *     bypass attempts fail at the network layer.
 *
 * Zero cost: a TCP CONNECT (no TLS, no HTTP body) merely proves reachability — no API call, no
 * Claude, no spend. Exit 0 = only-anthropic egress proven (4/4).
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NET = 'cage-internal-proof';
const PROXY = 'cage-proxy-proof';
const PROXY_IMG = 'cage-proxy:latest';
const CAGE_IMG = 'cage-claude:latest';

const sh = (cmd: string, args: string[], opts: { allowFail?: boolean } = {}) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8' }); }
  catch (e) { if (opts.allowFail) return ((e as { stdout?: string }).stdout ?? '') + ((e as { stderr?: string }).stderr ?? ''); throw e; }
};
const cleanup = () => {
  sh('docker', ['rm', '-f', PROXY], { allowFail: true });
  sh('docker', ['network', 'rm', NET], { allowFail: true });
};

export interface EgressProof { held: boolean; results: { invariant: string; held: boolean; detail: string }[]; probe: string; proxyLog: string }

export function proveEgressOnlyAnthropic(): EgressProof {
  // images
  execFileSync('bash', [path.join(here, 'build-proxy-image.sh'), PROXY_IMG], { stdio: 'inherit' });
  execFileSync('bash', [path.join(here, 'build-claude-cage-image.sh'), CAGE_IMG], { stdio: 'inherit' });
  cleanup();

  // 1. no-gateway internal network (cage has no direct route out)
  sh('docker', ['network', 'create', '--internal', NET]);
  // 2. proxy container: on the internal net (cage reaches it) + bridge (external route to Anthropic)
  sh('docker', ['run', '-d', '--name', PROXY, '--network', NET, PROXY_IMG, '8889']);
  sh('docker', ['network', 'connect', 'bridge', PROXY]); // add external route
  // give it a moment to be ready
  sh('sh', ['-c', 'sleep 1']);

  // 3. REAL probe in the cage on the internal net ONLY — proxy reachable by name.
  const PROBE = `
set +e
echo "## via-proxy-anthropic"
printf 'CONNECT api.anthropic.com:443 HTTP/1.1\\r\\nHost: api.anthropic.com:443\\r\\n\\r\\n' | busybox nc -w 6 ${PROXY} 8889 2>/dev/null | head -1 | sed 's/^/PROXY_ANTHROPIC:/'
echo "## via-proxy-denied"
printf 'CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n' | busybox nc -w 6 ${PROXY} 8889 2>/dev/null | head -1 | sed 's/^/PROXY_EXAMPLE:/'
echo "## direct-bypass (no proxy, raw IP — must fail under --internal)"
busybox nc -w 4 8.8.8.8 53 </dev/null 2>/dev/null && echo "DIRECT_8888:REACHED" || echo "DIRECT_8888:BLOCKED"
busybox nc -w 4 1.1.1.1 443 </dev/null 2>/dev/null && echo "DIRECT_1111:REACHED" || echo "DIRECT_1111:BLOCKED"
busybox nc -w 4 api.anthropic.com 443 </dev/null 2>/dev/null && echo "DIRECT_ANTHROPIC:REACHED" || echo "DIRECT_ANTHROPIC:BLOCKED"
echo "PROBE_DONE"
`;
  const probe = sh('docker', ['run', '--rm', '--network', NET, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', CAGE_IMG, '/bin/sh', '-c', PROBE], { allowFail: true });
  // Let the proxy's stderr flush to docker's log buffer before reading it.
  // NOTE: the proxy logs to STDERR (Go's log pkg). docker logs sends container stderr to its
  // own stderr, so merge 2>&1 to capture it (the 034.5-style "empty log" trap was actually a
  // capture bug here — verify the real path, don't trust an empty read).
  let proxyLog = '';
  for (let i = 0; i < 5; i++) {
    sh('sh', ['-c', 'sleep 0.5']);
    proxyLog = sh('sh', ['-c', `docker logs ${PROXY} 2>&1`], { allowFail: true });
    if (/api\.anthropic\.com:443 -> ALLOWED/.test(proxyLog)) break;
  }
  cleanup();

  const anthropicVia = /PROXY_ANTHROPIC:HTTP\/1\.[01] 200/.test(probe);
  const exampleDenied = /PROXY_EXAMPLE:HTTP\/1\.[01] 403/.test(probe);
  const directBlocked = /DIRECT_8888:BLOCKED/.test(probe) && /DIRECT_1111:BLOCKED/.test(probe) && /DIRECT_ANTHROPIC:BLOCKED/.test(probe);
  const proxyOnPath = /api\.anthropic\.com:443 -> ALLOWED/.test(proxyLog);

  const results = [
    { invariant: 'anthropic_reachable_via_proxy', held: anthropicVia, detail: anthropicVia ? 'CONNECT api.anthropic.com via proxy → 200 Established' : 'NOT reachable via proxy' },
    { invariant: 'all_other_hosts_denied_by_proxy', held: exampleDenied, detail: exampleDenied ? 'CONNECT example.com via proxy → 403 Forbidden' : 'example.com not denied (BAD)' },
    { invariant: 'direct_bypass_blocked_no_gateway', held: directBlocked, detail: directBlocked ? '8.8.8.8 / 1.1.1.1 / api.anthropic.com direct → all BLOCKED (--internal, no route)' : 'a direct connection succeeded (BYPASS!)' },
    { invariant: 'proxy_is_on_the_path_log_not_empty', held: proxyOnPath, detail: proxyOnPath ? 'proxy logged the api.anthropic.com CONNECT (contrast 034.5 empty log)' : 'proxy log shows no anthropic traffic' },
  ];
  return { held: results.every((r) => r.held), results, probe, proxyLog };
}

if (process.argv[1] && process.argv[1].endsWith('prove-egress.ts')) {
  let proof: EgressProof | undefined;
  try { proof = proveEgressOnlyAnthropic(); }
  finally { cleanup(); }
  console.log('\n──── probe output ────\n' + proof!.probe.trim() + '\n──────────────────────');
  console.log('proxy log:\n' + proof!.proxyLog.trim());
  console.log('\n──── Layer-1 egress invariants (REAL probe, hardened internal-network design) ────');
  for (const r of proof!.results) console.log(`${r.held ? 'HELD ' : 'FAIL '} ${r.invariant} — ${r.detail}`);
  console.log(proof!.held ? '\nONLY-ANTHROPIC EGRESS PROVEN (4/4) — Layer 1 is a REAL boundary now. (zero cost)' : '\nLAYER-1 NOT EFFECTIVE — egress not constrained as intended.');
  process.exit(proof!.held ? 0 : 1);
}

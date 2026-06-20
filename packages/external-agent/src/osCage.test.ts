import { describe, it, expect } from 'vitest';
import { buildDockerCageArgv } from './osCage';

const BASE = { image: 'cage-probe:latest', sandboxRoot: '/tmp/sb-copy', command: ['/bin/sh', '-c', 'true'] };

describe('OS cage argv builder (034.5) — structural invariants', () => {
  it('defaults to network none (OS-enforced default-deny)', () => {
    const a = buildDockerCageArgv(BASE);
    const i = a.indexOf('--network');
    expect(a[i + 1]).toBe('none');
  });

  it('only the sandbox copy is mounted writable, at /work', () => {
    const a = buildDockerCageArgv(BASE);
    const vols = a.filter((_, i) => a[i - 1] === '--volume');
    expect(vols).toEqual(['/tmp/sb-copy:/work']); // exactly one rw mount
    expect(a).toContain('--workdir');
    expect(a[a.indexOf('--workdir') + 1]).toBe('/work');
  });

  it('drops privilege: read-only root, all caps dropped, no-new-privileges, non-root user', () => {
    const a = buildDockerCageArgv(BASE);
    expect(a).toContain('--read-only');
    expect(a[a.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(a.join(' ')).toContain('no-new-privileges');
    expect(a[a.indexOf('--user') + 1]).toBe('65534:65534');
    expect(a).toContain('--rm');
  });

  it('host env is NOT inherited — only broker-provisioned auth values pass via -e', () => {
    const a = buildDockerCageArgv({ ...BASE, authEnv: { ANTHROPIC_API_KEY: 'sk-FAKE-x' } });
    const envs = a.filter((_, i) => a[i - 1] === '--env');
    expect(envs).toEqual(['ANTHROPIC_API_KEY=sk-FAKE-x']);
    // no HOME/SHELL/PATH leakage from the host process env
    expect(a.join(' ')).not.toContain('HOME=');
    expect(a.join(' ')).not.toContain('SHELL=');
  });

  it('REFUSES to mount any secret-looking path into the cage', () => {
    expect(() => buildDockerCageArgv({ ...BASE, extraRoMounts: [{ host: '/home/u/.ssh', cage: '/x' }] })).toThrow(/secret/i);
    expect(() => buildDockerCageArgv({ ...BASE, extraRoMounts: [{ host: '/home/u/.env', cage: '/x' }] })).toThrow(/secret/i);
    expect(() => buildDockerCageArgv({ ...BASE, extraRoMounts: [{ host: '/home/u/.codex/auth.json', cage: '/x' }] })).toThrow(/secret/i);
  });

  it('a non-secret read-only mount is allowed (e.g. a runtime), as :ro', () => {
    const a = buildDockerCageArgv({ ...BASE, extraRoMounts: [{ host: '/opt/node', cage: '/opt/node' }] });
    expect(a.join(' ')).toContain('/opt/node:/opt/node:ro');
  });

  it('the argv never contains a host secret/home/repo path', () => {
    const a = buildDockerCageArgv({ ...BASE, authEnv: { ANTHROPIC_API_KEY: 'sk-FAKE' } }).join(' ');
    for (const bad of ['/home/', '.env', '.ssh', '.codex', '/data/python/codeharness_workspace']) {
      expect(a).not.toContain(bad);
    }
  });
});

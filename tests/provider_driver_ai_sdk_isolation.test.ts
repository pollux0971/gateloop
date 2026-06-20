import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STORY-035.2 invariant: the Vercel AI SDK is ISOLATED behind the provider-driver seam — NO
 * package's source imports `ai` / `@ai-sdk/*`. The AI SDK is injected into aiSdkEngine.ts
 * (`streamText` is a parameter), so even provider-driver has no top-level SDK import. This keeps
 * the SDK swappable and prevents it recapturing the core (the whole reason ADR-020 left a
 * single-vendor SDK). 035.4 re-asserts this as part of the confinement barrier.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SDK_IMPORT = /(^|\n)\s*import[^\n;]*from\s*['"](ai|@ai-sdk[^'"]*)['"]/;
const SDK_REQUIRE = /require\(\s*['"](ai|@ai-sdk[^'"]*)['"]\s*\)/;

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(p, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

describe('STORY-035.2: AI SDK isolation — core never imports ai/@ai-sdk', () => {
  const files = [
    ...walk(path.join(root, 'packages')),
    ...walk(path.join(root, 'apps')),
  ];

  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('NO package source imports the AI SDK (it is injected, not imported)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (SDK_IMPORT.test(src) || SDK_REQUIRE.test(src)) offenders.push(path.relative(root, f));
    }
    expect(offenders, `AI SDK must not be imported (isolated behind injection): ${offenders.join(', ')}`).toEqual([]);
  });

  it('core packages do not even reference the AI SDK package names in imports', () => {
    const core = ['harness-core', 'agent-delegate', 'model-gateway', 'permission-gateway', 'gate-control', 'tool-interface'];
    const offenders: string[] = [];
    for (const f of files) {
      if (!core.some((c) => f.includes(`/packages/${c}/`))) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (SDK_IMPORT.test(src) || SDK_REQUIRE.test(src)) offenders.push(path.relative(root, f));
    }
    expect(offenders).toEqual([]);
  });
});

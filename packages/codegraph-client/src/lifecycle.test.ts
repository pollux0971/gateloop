import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  step0IndexArgs,
  checkpointSyncArgs,
  usesBackgroundWatcher,
  CODEGRAPH_DIR,
  excludeCodegraphFromGit,
  step0BuildIndex,
  checkpointSync,
  engineAvailable,
} from './index';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('STORY-CW.3: explicit lifecycle — never a background watcher', () => {
  it('step0 + checkpoint args are explicit (init/sync), never watch/serve', () => {
    expect(step0IndexArgs('/ws')).toContain('init');
    expect(step0IndexArgs('/ws')).toContain('--index');
    expect(checkpointSyncArgs('/ws')).toContain('sync');
    expect(usesBackgroundWatcher(step0IndexArgs('/ws'))).toBe(false);
    expect(usesBackgroundWatcher(checkpointSyncArgs('/ws'))).toBe(false);
    // the detector actually bites on watcher/serve modes (the forbidden magic)
    expect(usesBackgroundWatcher(['index', '--watch'])).toBe(true);
    expect(usesBackgroundWatcher(['serve', '--mcp'])).toBe(true);
  });
});

describe('STORY-CW.3: .codegraph/ in the product gitignore', () => {
  it('gateloop/.gitignore excludes .codegraph/', () => {
    const gi = fs.readFileSync(path.resolve(here, '../../../.gitignore'), 'utf8');
    expect(gi).toMatch(/^\.codegraph\/$/m);
  });
});

// Real engine: build at step0, sync at checkpoint, and the index never enters git. Local, zero API.
const ENGINE = engineAvailable();

describe.skipIf(!ENGINE)('STORY-CW.3: real index lifecycle (step0 build → checkpoint sync), excluded from git', () => {
  it('builds at step0, syncs incrementally, and the index stays out of the git diff', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cw3eng-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: ws, stdio: 'pipe' });
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 't@t.local']);
      git(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(ws, 'math.ts'), 'export function add(a: number, b: number){ return a + b; }\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);

      // Step 0: exclude the index from git, THEN build it (explicit, no watcher).
      excludeCodegraphFromGit(ws);
      const built = step0BuildIndex(ws);
      expect(built.ok).toBe(true);
      expect(fs.existsSync(path.join(ws, CODEGRAPH_DIR))).toBe(true);

      // A checkpoint changed a file → explicit incremental sync.
      fs.writeFileSync(path.join(ws, 'math.ts'),
        'export function add(a: number, b: number){ return a + b; }\nexport function sub(a: number, b: number){ return a - b; }\n');
      const synced = checkpointSync(ws);
      expect(synced.ok).toBe(true);

      // The authoritative diff captures the source change but NOT the index.
      git(['add', '-A']);
      const staged = execFileSync('git', ['diff', '--cached', '--name-only', 'HEAD'], { cwd: ws, encoding: 'utf8' });
      expect(staged).toMatch(/math\.ts/);
      expect(staged).not.toMatch(/\.codegraph/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 120_000);
});

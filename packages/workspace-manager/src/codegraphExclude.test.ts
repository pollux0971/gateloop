import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  WorkspaceRegistry,
  createDisposableWorkspace,
  seedFile,
  commitAll,
  collectDiffAgainstHead,
  excludeFromWorkspace,
  cleanupWorkspace,
} from './index';

/**
 * STORY-CW.3 — the codegraph index (`.codegraph/`) is harness state, NOT agent output. It must be
 * excluded from the exit-gate diff (collectDiffAgainstHead does `git add -A`, which would otherwise
 * stage the untracked index) so it never trips the write-set gate.
 */
describe('STORY-CW.3: .codegraph/ excluded from the exit-gate diff via .git/info/exclude', () => {
  it('an indexed workspace produces a clean diff with no .codegraph entries (write-set not flagged)', () => {
    const reg = new WorkspaceRegistry();
    const ws = createDisposableWorkspace(reg, { story_id: 'cw3' });
    try {
      seedFile(ws, 'src/app.ts', 'export const x = 1;\n');
      commitAll(ws, 'pre-task');
      // harness excludes .codegraph BEFORE the engine writes the index
      excludeFromWorkspace(ws, ['.codegraph/']);
      // codegraph writes its index; the agent makes a real (in-write-set) change
      fs.mkdirSync(path.join(ws.root, '.codegraph'), { recursive: true });
      fs.writeFileSync(path.join(ws.root, '.codegraph', 'status.txt'), 'index-state\n');
      fs.writeFileSync(path.join(ws.root, 'src', 'app.ts'), 'export const x = 2;\n');

      const diff = collectDiffAgainstHead(ws);
      expect(diff).toMatch(/app\.ts/); // the real change is captured
      expect(diff).not.toMatch(/\.codegraph/); // the index is NOT in the diff
    } finally {
      cleanupWorkspace(reg, ws);
    }
  });

  it('negative control: WITHOUT the exclude, .codegraph WOULD leak into the diff (proves the exclude bites)', () => {
    const reg = new WorkspaceRegistry();
    const ws = createDisposableWorkspace(reg, { story_id: 'cw3neg' });
    try {
      seedFile(ws, 'src/app.ts', 'export const x = 1;\n');
      commitAll(ws, 'pre-task');
      fs.mkdirSync(path.join(ws.root, '.codegraph'), { recursive: true });
      fs.writeFileSync(path.join(ws.root, '.codegraph', 'status.txt'), 'index-state\n');

      const diff = collectDiffAgainstHead(ws);
      expect(diff).toMatch(/\.codegraph/);
    } finally {
      cleanupWorkspace(reg, ws);
    }
  });

  it('excludeFromWorkspace is idempotent', () => {
    const reg = new WorkspaceRegistry();
    const ws = createDisposableWorkspace(reg, { story_id: 'cw3idem' });
    try {
      excludeFromWorkspace(ws, ['.codegraph/']);
      excludeFromWorkspace(ws, ['.codegraph/']);
      const exclude = fs.readFileSync(path.join(ws.root, '.git', 'info', 'exclude'), 'utf8');
      expect(exclude.split('\n').filter((l) => l.trim() === '.codegraph/')).toHaveLength(1);
    } finally {
      cleanupWorkspace(reg, ws);
    }
  });
});

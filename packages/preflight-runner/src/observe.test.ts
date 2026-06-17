/**
 * STORY — Developer pre-submit Observe (de-stubbed preflight).
 *
 * Proves the REAL execution layer: executePreflight APPLIES the proposed edits and
 * RUNS the affected tests for real, so an in-file behaviour deletion (a `modify`
 * that strips an earlier story's lines — the case the additive gate misses) is
 * caught as a red test. Two flavours:
 *   1. injected deterministic runners — fast unit coverage of the decision wiring;
 *   2. a GENUINE run (real fs + real `node --test`) — the honest proof it is not a
 *      map-reading stub.
 * CI-safe: no model, no network, no real_api_calls — only a tiny isolated workspace.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executePreflight,
  defaultApplyEdits,
  defaultRunTests,
  type PreflightEdit,
  type PreflightExecDeps,
} from './index';

// ── 1. Injected deterministic runners (decision wiring) ──────────────────────

describe('executePreflight — injected runners', () => {
  const noopApply = () => {};

  it('green run ⇒ passed + submit, executed:true (never a map read)', async () => {
    const deps: PreflightExecDeps = {
      applyEdits: noopApply,
      runTests: () => ({ passed: true, output: 'ok', failing: [] }),
    };
    const r = await executePreflight({ wsRoot: '/tmp/x', edits: [], affectedTests: ['s2.test.mjs'] }, deps);
    expect(r.executed).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.verdict).toBe('submit');
    expect(r.failing_tests).toEqual([]);
  });

  it('red affected test ⇒ passed:false, names the red test, verdict self_correct within budget', async () => {
    const deps: PreflightExecDeps = {
      applyEdits: noopApply,
      runTests: () => ({ passed: false, output: 'not ok', failing: ['greet keeps [S2:v2]'] }),
    };
    const r = await executePreflight(
      { wsRoot: '/tmp/x', edits: [], affectedTests: ['s2.test.mjs'], selfCorrectionAttempts: 0 },
      deps,
    );
    expect(r.passed).toBe(false);
    expect(r.failing_tests).toContain('greet keeps [S2:v2]');
    expect(r.verdict).toBe('self_correct');
  });

  it('red after budget exhausted ⇒ escalate, never loop', async () => {
    const deps: PreflightExecDeps = {
      applyEdits: noopApply,
      runTests: () => ({ passed: false, output: 'not ok', failing: ['t'] }),
    };
    const r = await executePreflight(
      { wsRoot: '/tmp/x', edits: [], affectedTests: ['t'], selfCorrectionAttempts: 2 },
      deps,
    );
    expect(r.verdict).toBe('escalate');
  });

  it('typecheck red ⇒ passed:false even when tests pass', async () => {
    const deps: PreflightExecDeps = {
      applyEdits: noopApply,
      runTypecheck: () => ({ ok: false, output: 'TS2322' }),
      runTests: () => ({ passed: true, output: 'ok', failing: [] }),
    };
    const r = await executePreflight({ wsRoot: '/tmp/x', edits: [] }, deps);
    expect(r.passed).toBe(false);
    expect(r.typecheck_ok).toBe(false);
    expect(r.failures).toContain('typecheck');
    expect(r.commands_run).toContain('pnpm typecheck');
  });
});

// ── 2. GENUINE run: real fs + real `node --test` (病根 proof) ─────────────────

describe('executePreflight — REAL run catches in-file behaviour deletion', () => {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function seedS2Workspace(): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gateloop-preflight-'));
    made.push(ws);
    // S2 (already merged): greet() carries the [S2:v2] behaviour, with its own test.
    fs.writeFileSync(path.join(ws, 's2.mjs'),
      `export function greet(name) { return \`Hello, \${name}! [S2:v2]\`; }\n`);
    fs.writeFileSync(path.join(ws, 's2.test.mjs'),
      `import { test } from 'node:test';\n` +
      `import assert from 'node:assert';\n` +
      `import { greet } from './s2.mjs';\n` +
      `test('greet keeps the [S2:v2] behaviour', () => {\n` +
      `  assert.ok(greet('x').includes('[S2:v2]'), 'S2 behaviour must be preserved');\n` +
      `});\n`);
    return ws;
  }

  it('a modify that DROPS S2 lines is caught red (additive gate would have missed it)', async () => {
    const ws = seedS2Workspace();
    // The buggy patch: a `modify` (NOT a delete) that overwrites s2.mjs WITHOUT the
    // [S2:v2] behaviour. operation:'modify' ⇒ the additive gate sees no delete and
    // would let this ship. The real test run is what catches it.
    const buggyEdits: PreflightEdit[] = [
      { path: 's2.mjs', operation: 'modify', content: `export function greet(name) { return \`Hello, \${name}!\`; }\n` },
    ];
    const r = await executePreflight(
      { wsRoot: ws, edits: buggyEdits, affectedTests: ['s2.test.mjs'], storyId: 'S3' },
      { applyEdits: defaultApplyEdits, runTests: defaultRunTests },
    );
    expect(r.executed).toBe(true);
    expect(r.passed).toBe(false);                 // S2 test went RED — deletion observed
    expect(r.verdict).toBe('self_correct');       // within budget ⇒ self-correct
    expect(r.failing_tests.length).toBeGreaterThan(0);
  });

  it('a correct patch that PRESERVES S2 passes the real run', async () => {
    const ws = seedS2Workspace();
    const goodEdits: PreflightEdit[] = [
      // Adds a new export while keeping the S2 behaviour intact.
      { path: 's2.mjs', operation: 'modify', content:
        `export function greet(name) { return \`Hello, \${name}! [S2:v2]\`; }\n` +
        `export function shout(name) { return greet(name).toUpperCase(); }\n` },
    ];
    const r = await executePreflight(
      { wsRoot: ws, edits: goodEdits, affectedTests: ['s2.test.mjs'], storyId: 'S3' },
      { applyEdits: defaultApplyEdits, runTests: defaultRunTests },
    );
    expect(r.passed).toBe(true);
    expect(r.verdict).toBe('submit');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WorkspaceRegistry,
  createDisposableWorkspace,
  seedFile,
  commitAll,
  cleanupWorkspace,
  type WorkspaceManifest,
} from '@gateloop/workspace-manager';
import type { ExitGateContract } from '@gateloop/agent-delegate';
import { runControlledBash, controlledBashDriver, type ScriptedCli } from './controlledBash';
import { cliModeProducer, runBuilderMode } from './index';

const reg = new WorkspaceRegistry();
const made: WorkspaceManifest[] = [];

/** A sandbox copy with a committed pre-delegation tree (one existing file). */
function freshSandbox(): WorkspaceManifest {
  const ws = createDisposableWorkspace(reg, { story_id: 'S1-bridge' });
  seedFile(ws, 'README.md', '# toolkit\n');
  commitAll(ws, 'pre-delegation tree');
  made.push(ws);
  return ws;
}

afterEach(() => {
  while (made.length) cleanupWorkspace(reg, made.pop()!);
});

/** A scripted CLI: writes slugify.mjs IN-sandbox, then ATTEMPTS to write outside it. */
const SCRIPTED: ScriptedCli = {
  cli: 'claude',
  actions: [
    { argv: ['bash', '-c', 'cat > slugify.mjs'], writes: [{ path: 'slugify.mjs', content: 'export function slugify(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");}\n' }] },
    { argv: ['bash', '-c', 'echo run tests'] },
    // escape attempt — must be REFUSED, real tree untouched:
    { argv: ['bash', '-c', 'echo pwned > ../escape.txt'], writes: [{ path: '../escape.txt', content: 'pwned' }] },
  ],
};

describe('controlled-bash bridge (034.3)', () => {
  it('bash_working_dir_confined_to_sandbox_copy_writes_cannot_escape', () => {
    const ws = freshSandbox();
    const res = runControlledBash(ws, SCRIPTED);
    // the escape attempt was refused
    expect(res.blocked_writes).toContain('../escape.txt');
    // the in-sandbox write landed
    expect(fs.existsSync(path.join(ws.root, 'slugify.mjs'))).toBe(true);
    // the REAL tree outside the sandbox was NOT written
    expect(fs.existsSync(path.resolve(ws.root, '../escape.txt'))).toBe(false);
  });

  it('harness_records_commands_run_into_event_stream', () => {
    const ws = freshSandbox();
    const res = runControlledBash(ws, SCRIPTED);
    // every command is recorded (3 actions), as observation events
    expect(res.recorded).toHaveLength(3);
    const cmdEvents = res.events.filter(e => e.kind === 'tool_call' && e.tool === 'bash');
    expect(cmdEvents).toHaveLength(3);
    expect(cmdEvents.map(e => e.summary).join('\n')).toContain('cat > slugify.mjs');
    // the blocked command is recorded as blocked, not silently dropped
    const blockedRec = res.recorded.find(r => r.blocked_writes.includes('../escape.txt'));
    expect(blockedRec?.confined).toBe(false);
  });

  it('bridge_emits_agent_event_stream_and_diff_vs_pre_delegation_tree', () => {
    const ws = freshSandbox();
    const res = runControlledBash(ws, SCRIPTED);
    // AgentEvent stream ends with a completion
    expect(res.events.at(-1)?.kind).toBe('completion');
    // authoritative diff vs the pre-delegation tree shows the new in-sandbox file...
    expect(res.diff).toContain('slugify.mjs');
    // ...and NOT the escaped file (it was never written)
    expect(res.diff).not.toContain('escape.txt');
  });

  it('bridge_tested_with_scripted_stub_cli_no_real_spend', () => {
    const ws = freshSandbox();
    // No child process / no network / no real CLI — purely scripted actions + local git/fs.
    const res = runControlledBash(ws, { cli: 'claude', actions: [{ argv: ['bash', '-c', 'true'] }] });
    expect(res.events.some(e => e.kind === 'completion')).toBe(true);
    expect(res.recorded).toHaveLength(1);
  });

  it('reuses_033_headless_driver_plumbing', async () => {
    const ws = freshSandbox();
    // The bridge IS a 033 ExternalAgentDriver; the 034.2 cli_mode producer consumes it
    // unchanged, and the result flows through the shared exit gate.
    const { driver, getResult } = controlledBashDriver(ws, {
      cli: 'claude',
      actions: [{ argv: ['bash', '-c', 'cat > slugify.mjs'], writes: [{ path: 'slugify.mjs', content: 'export const x=1;\n' }] }],
    });
    expect(driver.driver).toBe('headless');
    const producer = cliModeProducer('claude', driver, () => getResult().diff);
    const contract: ExitGateContract = {
      story_id: 'S1',
      allowed_write_set: ['slugify.mjs'],
      acceptance_criteria: { behaviors_must_pass: ['slugify_exists'] },
    };
    const run = await runBuilderMode({
      mode: 'cli_mode',
      producer,
      packet: { prompt: 'build slugify', allowed_write_set: ['slugify.mjs'] },
      sandbox: { cwd: ws.root },
      contract,
    });
    // end-to-end: controlled-bash diff → shared exit gate → accepted (in-write-set)
    expect(run.verdict.changed_files).toContain('slugify.mjs');
    expect(run.verdict.accepted).toBe(true);
    expect(run.decision.action).toBe('write_checkpoint');
  });
});

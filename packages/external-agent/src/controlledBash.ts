/**
 * Controlled-bash bridge (EPIC-034 / STORY-034.3).
 *
 * Deepens EPIC-033's "spawn + parse JSON" into a real controlled bash: the mechanism by
 * which a CLI agent gets a shell to work in, and by which the harness GOVERNS and OBSERVES
 * that shell. Three guarantees (docs/architecture/18_DUAL_MODE_BUILDER.md §2):
 *   1. WRITE CONFINEMENT — the working dir is the sandbox copy; any write whose resolved
 *      path escapes sandbox.root is REFUSED (the real tree is never touched);
 *   2. OBSERVATION — every command the agent runs is recorded into the AgentEvent stream
 *      (audit/cockpit), explicitly NOT a trust signal;
 *   3. OUTPUT — the run yields a 033 AgentEvent stream + the authoritative diff vs the
 *      pre-delegation tree (so in-sandbox git tampering cannot hide a change).
 *
 * This story builds and tests the bridge with a SCRIPTED/STUB CLI — no real Claude Code is
 * spawned (real-binary isolation proof is 034.4; the gated real run is 034.5). The
 * confinement + diff use real local git/fs (CI-safe, zero spend, no network).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type WorkspaceManifest, isPathInsideRoot, collectDiffAgainstHead } from '@gateloop/workspace-manager';
import type {
  AgentEvent,
  CliKind,
  DelegationTaskPacket,
  SandboxHandle,
  ExternalAgentDriver,
} from '@gateloop/agent-delegate';

/** One bash action the CLI agent performs in the sandbox. Scripted for tests; in a real
 *  run these are derived from the CLI's tool-call stream. `writes` are the files the
 *  action would create/modify — confinement is enforced on their resolved paths. */
export interface BashAction {
  argv: string[];
  writes?: { path: string; content: string }[];
}

export interface RecordedCommand {
  argv: string[];
  cwd: string;
  /** True iff every write stayed inside the sandbox copy. */
  confined: boolean;
  /** Write targets that escaped the sandbox and were REFUSED. */
  blocked_writes: string[];
}

export interface ScriptedCli {
  cli: CliKind;
  actions: BashAction[];
}

export interface ControlledBashResult {
  /** 033 AgentEvent stream: one tool_call per command + a terminal completion. */
  events: AgentEvent[];
  /** Per-command audit record (observation, never trust). */
  recorded: RecordedCommand[];
  /** Every escape attempt across all commands — refused; the real tree is untouched. */
  blocked_writes: string[];
  /** AUTHORITATIVE diff vs the pre-delegation tree (the only thing the exit gate consumes). */
  diff: string;
}

/**
 * Run a scripted CLI's bash actions under harness control inside the sandbox copy.
 * Writes are confined; commands are recorded; the result carries the AgentEvent stream and
 * the authoritative diff vs the pre-delegation tree. PURE of any real CLI spawn.
 */
export function runControlledBash(ws: WorkspaceManifest, scripted: ScriptedCli): ControlledBashResult {
  const events: AgentEvent[] = [];
  const recorded: RecordedCommand[] = [];
  const blocked_writes: string[] = [];

  for (const action of scripted.actions) {
    const blocked: string[] = [];
    for (const w of action.writes ?? []) {
      const abs = path.resolve(ws.root, w.path);
      if (!isPathInsideRoot(ws.root, abs)) {
        // ESCAPE ATTEMPT — refuse. The real tree is never written. The cage holds.
        blocked.push(w.path);
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, w.content);
    }
    const confined = blocked.length === 0;
    blocked_writes.push(...blocked);
    recorded.push({ argv: action.argv, cwd: ws.root, confined, blocked_writes: blocked });
    // OBSERVATION — record the command into the event stream. Audit only, never trust.
    events.push({
      cli: scripted.cli,
      kind: 'tool_call',
      tool: 'bash',
      summary: `[${confined ? 'ran' : 'blocked-escape'}] ${action.argv.join(' ')}`,
      raw: { argv: action.argv, blocked_writes: blocked },
    });
  }

  // AUTHORITATIVE diff vs the pre-delegation snapshot (includes new files).
  const diff = collectDiffAgainstHead(ws);
  events.push({
    cli: scripted.cli,
    kind: 'completion',
    summary: 'controlled-bash run complete',
    stop_reason: 'end_turn',
    tokens: { input: 0, output: 0 },
  });

  return { events, recorded, blocked_writes, diff };
}

/**
 * Expose a controlled-bash run AS a 033 `ExternalAgentDriver` (driver: 'headless'), so the
 * 034.2 `cliModeProducer` consumes it UNCHANGED — reusing 033's driver interface +
 * AgentEvent contract (no rebuild). The run executes when the driver's stream is consumed;
 * `getResult()` then exposes the authoritative diff for the producer's `getDiff`.
 */
export function controlledBashDriver(
  ws: WorkspaceManifest,
  scripted: ScriptedCli,
): { driver: ExternalAgentDriver; getResult: () => ControlledBashResult } {
  let result: ControlledBashResult | null = null;
  const driver: ExternalAgentDriver = {
    driver: 'headless',
    async *run(_packet: DelegationTaskPacket, _sandbox: SandboxHandle): AsyncIterable<AgentEvent> {
      result = runControlledBash(ws, scripted);
      for (const ev of result.events) yield ev;
    },
  };
  return {
    driver,
    getResult: () => {
      if (!result) throw new Error('controlled-bash driver has not run yet');
      return result;
    },
  };
}

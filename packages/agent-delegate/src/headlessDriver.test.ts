import { describe, it, expect } from 'vitest';
import {
  HeadlessDriver,
  buildHeadlessCommand,
  parseHeadlessLine,
  parseClaudeEvent,
  parseCodexEvent,
  parseGeminiEvent,
  mockProcessSpawner,
  collectEvents,
  isCliKind,
  CLI_KINDS,
  type ExternalAgentDriver,
  type DelegationTaskPacket,
  type SandboxHandle,
  type AgentEvent,
} from './headlessDriver';

// ── Conjectured recorded outputs (⚠ calibrate against real streams in STORY-033.9) ──
// These are best-known shapes from public docs/observation; the SPIKE verified flags
// and output FORMAT against real binaries but per-event FIELD shapes need a gated run.

const CLAUDE_LINES = [
  JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking about it' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 120, output_tokens: 45 } }),
];

const CODEX_LINES = [
  JSON.stringify({ msg: { type: 'agent_reasoning' } }),
  JSON.stringify({ msg: { type: 'exec_command', command: 'pnpm test' } }),
  JSON.stringify({ msg: { type: 'agent_message', message: 'patched a.ts' } }),
  JSON.stringify({ msg: { type: 'task_complete', usage: { input_tokens: 90, output_tokens: 30 } } }),
];

const GEMINI_LINES = [
  JSON.stringify({ type: 'thought' }),
  JSON.stringify({ type: 'tool_call', name: 'edit_file' }),
  JSON.stringify({ type: 'content', text: 'edited' }),
  JSON.stringify({ type: 'result', stats: { input_tokens: 60, output_tokens: 20 } }),
];

const PACKET: DelegationTaskPacket = {
  prompt: 'implement the feature',
  allowed_write_set: ['a.ts'],
};

const SANDBOX: SandboxHandle = { cwd: '/tmp/sandbox-x', env: {}, sandbox_mode: 'workspace-write' };

describe('agent-delegate / headless driver (STORY-033.2)', () => {
  // ── external_agent_driver_interface_defined ──
  it('external_agent_driver_interface_defined', () => {
    const driver: ExternalAgentDriver = new HeadlessDriver({ cli: 'claude', spawner: mockProcessSpawner([]) });
    expect(driver.driver).toBe('headless');
    expect(typeof driver.run).toBe('function');
    expect(CLI_KINDS).toEqual(['claude', 'codex', 'gemini']);
    expect(isCliKind('codex')).toBe(true);
    expect(isCliKind('nope')).toBe(false);
  });

  // ── headless_driver_spawns_cli_noninteractive ──
  it('headless_driver_spawns_cli_noninteractive', () => {
    const claude = buildHeadlessCommand('claude', PACKET, SANDBOX);
    expect(claude.command).toBe('claude');
    expect(claude.noninteractive).toBe(true);
    expect(claude.args).toContain('--print');           // non-interactive
    expect(claude.args).toContain('--bare');
    expect(claude.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']));
    expect(claude.args[claude.args.length - 1]).toBe(PACKET.prompt);
    expect(claude.auth_env_var).toBe('ANTHROPIC_API_KEY');

    const codex = buildHeadlessCommand('codex', PACKET, SANDBOX);
    expect(codex.command).toBe('codex');
    expect(codex.args[0]).toBe('exec');                  // non-interactive subcommand
    expect(codex.args).toContain('--json');
    expect(codex.args).toContain('--ephemeral');
    expect(codex.args).toEqual(expect.arrayContaining(['-s', 'workspace-write']));
    expect(codex.auth_env_var).toBe('CODEX_HOME');

    const gemini = buildHeadlessCommand('gemini', PACKET, SANDBOX);
    expect(gemini.command).toBe('gemini');
    expect(gemini.args).toContain('--yolo');
    expect(gemini.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']));
    expect(gemini.auth_env_var).toBe('GEMINI_API_KEY');
  });

  it('optional native schema + budget flags only appear when requested', () => {
    const plain = buildHeadlessCommand('claude', PACKET, SANDBOX);
    expect(plain.args).not.toContain('--json-schema');
    expect(plain.args).not.toContain('--max-budget-usd');

    const rich = buildHeadlessCommand(
      'claude',
      { ...PACKET, output_schema_path: '/tmp/s.json', max_budget_usd: 0.5 },
      SANDBOX,
    );
    expect(rich.args).toEqual(expect.arrayContaining(['--json-schema', '/tmp/s.json']));
    expect(rich.args).toEqual(expect.arrayContaining(['--max-budget-usd', '0.5']));

    // Codex uses its native --output-schema for the same packet field.
    const codex = buildHeadlessCommand('codex', { ...PACKET, output_schema_path: '/tmp/s.json' }, SANDBOX);
    expect(codex.args).toEqual(expect.arrayContaining(['--output-schema', '/tmp/s.json']));
  });

  // ── structured_json_parsed_to_agent_events ──
  it('structured_json_parsed_to_agent_events: claude', () => {
    const evs = CLAUDE_LINES.map((l) => parseHeadlessLine('claude', l)).filter(Boolean) as AgentEvent[];
    expect(evs.map((e) => e.kind)).toEqual(['session', 'message', 'tool_call', 'completion']);
    const tool = evs.find((e) => e.kind === 'tool_call')!;
    expect(tool.tool).toBe('Edit');
    const done = evs.find((e) => e.kind === 'completion')!;
    expect(done.stop_reason).toBe('end_turn');
    expect(done.tokens).toEqual({ input: 120, output: 45 });
  });

  it('structured_json_parsed_to_agent_events: codex', () => {
    const evs = CODEX_LINES.map((l) => parseHeadlessLine('codex', l)).filter(Boolean) as AgentEvent[];
    expect(evs.map((e) => e.kind)).toEqual(['thinking', 'tool_call', 'message', 'completion']);
    expect(evs.find((e) => e.kind === 'completion')!.tokens).toEqual({ input: 90, output: 30 });
  });

  it('structured_json_parsed_to_agent_events: gemini', () => {
    const evs = GEMINI_LINES.map((l) => parseHeadlessLine('gemini', l)).filter(Boolean) as AgentEvent[];
    expect(evs.map((e) => e.kind)).toEqual(['thinking', 'tool_call', 'message', 'completion']);
    expect(evs.find((e) => e.kind === 'completion')!.tokens).toEqual({ input: 60, output: 20 });
  });

  it('non-JSON noise lines are skipped (return null), never crash', () => {
    expect(parseHeadlessLine('claude', '')).toBeNull();
    expect(parseHeadlessLine('claude', 'Starting Claude Code...')).toBeNull();
    expect(parseHeadlessLine('codex', '   ')).toBeNull();
  });

  it('unclassified JSON lines are kept as kind=unknown, not dropped', () => {
    const ev = parseClaudeEvent({ type: 'some_future_event', foo: 1 });
    expect(ev.kind).toBe('unknown');
    expect(ev.raw).toEqual({ type: 'some_future_event', foo: 1 });
    expect(parseCodexEvent({ msg: { type: 'mystery' } }).kind).toBe('unknown');
    expect(parseGeminiEvent({ type: 'mystery' }).kind).toBe('unknown');
  });

  it('error lines map to kind=error', () => {
    expect(parseClaudeEvent({ type: 'error', message: 'boom' }).kind).toBe('error');
    expect(parseCodexEvent({ msg: { type: 'error', message: 'boom' } }).kind).toBe('error');
    expect(parseGeminiEvent({ type: 'error', message: 'boom' }).kind).toBe('error');
  });

  // ── proven_against_mock_ci_safe ──
  it('proven_against_mock_ci_safe: full run via mock spawner, no real process', async () => {
    const driver = new HeadlessDriver({ cli: 'claude', spawner: mockProcessSpawner(CLAUDE_LINES, 0) });
    const evs = await collectEvents(driver.run(PACKET, SANDBOX));
    expect(evs.map((e) => e.kind)).toEqual(['session', 'message', 'tool_call', 'completion']);
    // exactly one completion reaches the exit gate
    expect(evs.filter((e) => e.kind === 'completion')).toHaveLength(1);
    // every event is tagged with the producing CLI
    expect(evs.every((e) => e.cli === 'claude')).toBe(true);
  });

  it('synthesizes a completion when the CLI stream has none (clean exit)', async () => {
    const driver = new HeadlessDriver({ cli: 'gemini', spawner: mockProcessSpawner([GEMINI_LINES[0]], 0) });
    const evs = await collectEvents(driver.run(PACKET, SANDBOX));
    const done = evs.filter((e) => e.kind === 'completion');
    expect(done).toHaveLength(1);
    expect(done[0].stop_reason).toBe('end_turn');
    expect(done[0].raw).toMatchObject({ synthesized: true, exit_code: 0 });
  });

  it('synthesizes an error completion on non-zero exit with no terminal event', async () => {
    const driver = new HeadlessDriver({ cli: 'codex', spawner: mockProcessSpawner([CODEX_LINES[0]], 137) });
    const evs = await collectEvents(driver.run(PACKET, SANDBOX));
    const done = evs.find((e) => e.kind === 'completion')!;
    expect(done.stop_reason).toBe('error');
    expect(done.raw).toMatchObject({ synthesized: true, exit_code: 137 });
  });

  it('plan() exposes the would-be invocation without spawning', () => {
    const driver = new HeadlessDriver({ cli: 'codex', spawner: mockProcessSpawner([]) });
    const plan = driver.plan(PACKET, SANDBOX);
    expect(plan.command).toBe('codex');
    expect(plan.noninteractive).toBe(true);
  });
});

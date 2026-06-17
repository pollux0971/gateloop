import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  isCliModel,
  cliModelsFromRegistry,
  cliAuthEnvVar,
  resolveCliInvocation,
  routeResolvesToCliModel,
  validateModelRegistryV2,
  findModel,
  type ModelEntry,
  type RoutingConfig,
} from './index';

const models: ModelEntry[] = parseYaml(fs.readFileSync('configs/models.yaml', 'utf8')).models;

describe('STORY-033.8: external CLI tools registered as kind=cli (driver=headless)', () => {
  // ── cli_tool_registered_as_kind_cli_driver_headless ──
  it('cli_tool_registered_as_kind_cli_driver_headless', () => {
    const clis = cliModelsFromRegistry(models);
    const names = clis.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['claude-code-cli', 'codex-cli', 'gemini-cli']));
    for (const m of clis) {
      expect(isCliModel(m)).toBe(true);
      expect(m.cli?.driver).toBe('headless');     // headless is the primary driver
      expect(m.cli?.command).toBeTruthy();
    }
    // the real registry still validates (CLI entries are not routed, so routing is fine)
    const routing: RoutingConfig = parseYaml(fs.readFileSync('configs/model_routing.yaml', 'utf8'));
    expect(validateModelRegistryV2(models, routing).ok).toBe(true);
  });

  // ── command_instead_of_base_url ──
  it('command_instead_of_base_url: CLI tools carry command+args+auth env, no base_url', () => {
    const claude = findModel('claude-code-cli', models)!;
    expect(claude.base_url).toBeUndefined();
    const inv = resolveCliInvocation(claude);
    expect(inv.command).toBe('claude');
    expect(inv.driver).toBe('headless');
    expect(inv.args).toContain('--print');
    expect(inv.auth_env_var).toBe('ANTHROPIC_API_KEY');   // derived from command
    expect(inv.secret_handle).toBe('provider.anthropic.cli');

    expect(cliAuthEnvVar('codex')).toBe('CODEX_HOME');
    expect(cliAuthEnvVar('/usr/local/bin/gemini')).toBe('GEMINI_API_KEY');  // basename-aware
    expect(cliAuthEnvVar('unknowncli')).toBeUndefined();

    // a non-CLI model cannot be resolved as a CLI invocation
    const apiModel = findModel('gpt-5.4-mini', models)!;
    expect(() => resolveCliInvocation(apiModel)).toThrow();
  });

  // ── agent_role_routable_to_cli_tool ──
  it('agent_role_routable_to_cli_tool: an agent routes to a CLI tool by name like any model', () => {
    const cliModels = cliModelsFromRegistry(models);
    // route the developer's primary to the Claude CLI tool by its self-chosen name
    const routing: RoutingConfig = { agents: { developer: { primary: 'claude-code-cli' } } };
    expect(validateModelRegistryV2(models, routing).ok).toBe(true);
    expect(routeResolvesToCliModel(routing, 'developer', 'default', models)).toBe(true);

    // a fallback to a CLI tool also resolves
    const withFallback: RoutingConfig = { agents: { developer: { primary: 'deepseek-v4-pro', fallbacks: ['codex-cli'] } } };
    expect(routeResolvesToCliModel(withFallback, 'developer', 'default', models)).toBe(true);

    // routing only to API models does NOT resolve to a CLI tool
    const apiOnly: RoutingConfig = { agents: { developer: { primary: 'deepseek-v4-pro' } } };
    expect(routeResolvesToCliModel(apiOnly, 'developer', 'default', models)).toBe(false);

    expect(cliModels.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * @gateloop/api — model registry + routing helpers (UI WORK 2).
 *
 * Pure functions (no server) so the route handlers stay thin and the logic is
 * testable against a temp repo. They read configs/models.yaml + model_routing.yaml
 * and apply a routing change by editing the YAML IN PLACE (comments preserved) after
 * validating the model exists and the agent is known. Config only — never touches
 * real_api_calls, never reads a secret value (only the broker handle string lives here).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';

export interface ApiModel {
  name: string;
  kind: string;
  vendor?: string;
  description?: string;
  capabilities?: string[];
  base_url?: string;
  pricing?: { input?: number; output?: number; cache_input?: number };
  limit?: number;
  cli?: { driver: string; command: string; args?: string[] };
}

export interface AgentRoute { agent: string; model: string }

const modelsPath = (repo: string) => path.join(repo, 'configs', 'models.yaml');
const routingPath = (repo: string) => path.join(repo, 'configs', 'model_routing.yaml');

/** All registered models (with the WORK 1 description/capabilities/vendor fields). */
export function readModels(repo: string): ApiModel[] {
  const y = parseYaml(fs.readFileSync(modelsPath(repo), 'utf8')) as { models?: ApiModel[] };
  return y?.models ?? [];
}

/** Raw parsed routing config. */
export function readRouting(repo: string): { agents?: Record<string, { primary?: string }> } {
  return (parseYaml(fs.readFileSync(routingPath(repo), 'utf8')) as { agents?: Record<string, { primary?: string }> }) ?? {};
}

/** agent → currently-assigned (primary) model, one row per agent. */
export function routingRows(routing: { agents?: Record<string, { primary?: string }> }): AgentRoute[] {
  return Object.entries(routing?.agents ?? {}).map(([agent, cfg]) => ({ agent, model: cfg?.primary ?? '' }));
}

// ── Router config (UI WORK D) — enabled + a plain-language mode (λ stays internal) ──
export type RouterMode = 'save-money' | 'balanced' | 'reliable';
export interface RouterConfig { enabled: boolean; mode: RouterMode }

const LAMBDA_BY_MODE: Record<RouterMode, number> = { 'save-money': 1.2, balanced: 0.5, reliable: 0.1 };
/** Map the operator's plain-language mode to the router's cost weight λ (never shown in UI). */
export function lambdaForMode(mode: RouterMode): number { return LAMBDA_BY_MODE[mode] ?? 0.5; }

const routerConfigPath = (repo: string) => path.join(repo, 'configs', 'router_config.yaml');

export function readRouterConfig(repo: string): RouterConfig {
  try {
    const y = parseYaml(fs.readFileSync(routerConfigPath(repo), 'utf8')) as { enabled?: boolean; mode?: string };
    const mode = (['save-money', 'balanced', 'reliable'] as string[]).includes(y?.mode ?? '') ? (y!.mode as RouterMode) : 'balanced';
    return { enabled: Boolean(y?.enabled), mode };
  } catch { return { enabled: false, mode: 'balanced' }; }
}

export interface RouterConfigUpdate { enabled?: boolean; mode?: RouterMode }
/** Update router config in place (comments preserved); rejects an invalid mode. */
export function applyRouterConfig(repo: string, update: RouterConfigUpdate): { ok: boolean; error?: string; config?: RouterConfig } {
  const cur = readRouterConfig(repo);
  const next: RouterConfig = { enabled: update.enabled ?? cur.enabled, mode: update.mode ?? cur.mode };
  if (!(['save-money', 'balanced', 'reliable'] as string[]).includes(next.mode)) {
    return { ok: false, error: `invalid mode: ${next.mode}` };
  }
  const doc = parseDocument(fs.readFileSync(routerConfigPath(repo), 'utf8'));
  doc.set('enabled', next.enabled);
  doc.set('mode', next.mode);
  fs.writeFileSync(routerConfigPath(repo), String(doc));
  return { ok: true, config: next };
}

export interface RoutingUpdateResult { ok: boolean; error?: string }

/**
 * Set an agent's primary model. Validates the model exists in the registry and the
 * agent already has a routing entry, then edits model_routing.yaml IN PLACE via the
 * YAML Document API so comments and formatting survive. Rejects unknown model/agent.
 */
export function applyRoutingUpdate(repo: string, agent: string, model: string): RoutingUpdateResult {
  if (!agent || !model) return { ok: false, error: 'agent and model are required' };
  if (!readModels(repo).some(m => m.name === model)) return { ok: false, error: `unknown model: ${model}` };
  const doc = parseDocument(fs.readFileSync(routingPath(repo), 'utf8'));
  if (!doc.hasIn(['agents', agent])) return { ok: false, error: `unknown agent: ${agent}` };
  doc.setIn(['agents', agent, 'primary'], model);
  fs.writeFileSync(routingPath(repo), String(doc));
  return { ok: true };
}

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

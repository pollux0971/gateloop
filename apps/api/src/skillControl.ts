/**
 * STORY-GATE.5 — cockpit skill-control handler with the §4d SERVER-ENFORCED boundary.
 *
 * The Fastify endpoints are thin wrappers over handleSkillControl; the boundary is
 * decided by @gateloop/skill-runtime::decideSkillControl (server code, not UI). IO is
 * injected so the handler — including every refusal — is testable with no HTTP and no fs.
 *
 * It can ONLY mutate the skill catalog (toggle enabled / stage an add for the test-gate /
 * delete a non-builtin). It never reads or writes policy.yaml, never touches real_api_calls,
 * never widens a write-set or tool grant — by construction it has no path to them.
 */
import { decideSkillControl, type SkillControlRequest } from '@gateloop/skill-runtime';

export interface SkillCatalogEntry {
  skill_id: string;
  agent_role?: string;
  path?: string;
  status?: string;
  enabled?: boolean;
  builtin?: boolean;
  [k: string]: unknown;
}
export interface SkillCatalog { skills: SkillCatalogEntry[] }

export interface SkillCatalogIO {
  read(): SkillCatalog;
  write(c: SkillCatalog): void;
}

export interface HandlerResult { code: number; body: unknown }

/**
 * Handle a cockpit skill-control request. Returns an HTTP-shaped {code, body}.
 *   - 200: the user decision was applied (toggle / delete-non-builtin) or the add was
 *          registered ACTIVE (STORY-TRUST.6 / ADR-0013: the test-gate is retired — a skill
 *          the operator adds is registered as-is, unvalidated; no needs_tests staging).
 *   - 403: the §4d boundary refused it (overreach / forbidden op / builtin delete).
 *   - 404: skill not found.
 */
export function handleSkillControl(req: SkillControlRequest, io: SkillCatalogIO): HandlerResult {
  const catalog = io.read();
  const findSkill = (id: string) => catalog.skills.find(s => s.skill_id === id);

  const decision = decideSkillControl(req, { findSkill });
  if (!decision.allow) {
    return { code: 403, body: { error: decision.reason, boundary: 'server-enforced' } };
  }

  switch (decision.op) {
    case 'toggle': {
      const s = findSkill(String(req.skill_id));
      if (!s) return { code: 404, body: { error: 'skill not found' } };
      s.enabled = req.enabled; // pure user decision — applied, not gated
      io.write(catalog);
      return { code: 200, body: { skill_id: s.skill_id, enabled: s.enabled } };
    }
    case 'delete': {
      const idx = catalog.skills.findIndex(s => s.skill_id === req.skill_id);
      if (idx < 0) return { code: 404, body: { error: 'skill not found' } };
      catalog.skills.splice(idx, 1);
      io.write(catalog);
      return { code: 200, body: { deleted: req.skill_id } };
    }
    case 'add': {
      const m = req.manifest!;
      // STORY-TRUST.6 (ADR-0013): the test-gate is RETIRED — a skill the operator adds is
      // registered ACTIVE (status:'registered'), unvalidated. No `needs_tests` stamp (which
      // would bench it: skill-runtime's selectSkillsForRole excludes non-'registered'); no
      // test-gate note. The engine is UNCHANGED — registering active here simply means the
      // runtime's needs_tests exclusion never triggers on the API path. Tests are an optional
      // self-check, not a gate (the operator trusts their own skills).
      const added: SkillCatalogEntry = {
        skill_id: m.skill_id, agent_role: m.agent_role, path: m.path,
        status: 'registered', enabled: true, builtin: false,
      };
      catalog.skills.push(added);
      io.write(catalog);
      return { code: 200, body: { added: m.skill_id, status: 'registered', note: 'registered unvalidated (operator-trust; tests are an optional self-check, not a gate)' } };
    }
    default:
      return { code: 403, body: { error: 'unhandled op', boundary: 'server-enforced' } };
  }
}

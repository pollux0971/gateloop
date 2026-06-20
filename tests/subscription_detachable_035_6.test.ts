import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretBroker, staticSource } from '@gateloop/secret-broker';
import { createMeteredEngine, pickMeteredBackend, ProviderDriver } from '@gateloop/provider-driver';
import type { AiSdkStreamText } from '@gateloop/provider-driver';
import type { AgentEvent } from '@gateloop/agent-delegate';

/**
 * STORY-035.6 — the subscription path is a DETACHABLE plugin. The core (provider-driver engine +
 * tool layer + exit gate + router + the metered createMeteredEngine) must NOT depend on
 * @gateloop/subscription-auth, so removing the plugin (or its endpoint breaking) leaves the metered
 * core path fully intact. Proven two ways: a 0-importer scan of the import graph, and a metered run
 * that touches no subscription code. Zero cost, no network.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === 'dist') continue; walk(p, acc); }
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const SUB_IMPORT = /(^|\n)\s*import[^\n;]*from\s*['"](@gateloop\/subscription-auth|.*subscription-auth)['"]/;

describe('STORY-035.6: subscription is a DETACHABLE plugin — core does not depend on it', () => {
  it('NO package/app source imports @gateloop/subscription-auth (only scripts may wire it)', () => {
    const files = [...walk(path.join(root, 'packages')), ...walk(path.join(root, 'apps'))]
      .filter((f) => !f.includes('/packages/subscription-auth/')); // the plugin itself is allowed to be itself
    const offenders = files.filter((f) => SUB_IMPORT.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
    expect(offenders, `core must not depend on the subscription plugin: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the metered core path runs with ZERO subscription code involved', async () => {
    // A metered engine built + driven with no reference to subscription-auth — proves that
    // removing the subscription plugin leaves the endorsed metered-key path fully usable.
    const broker = new SecretBroker(staticSource({ openai: 'sk-METERED-detach' }));
    const fakeStreamText: AiSdkStreamText = ({ model }) => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: `metered:${(model as { id: string }).id}` };
        yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } };
      })(),
    });
    const engine = await createMeteredEngine({
      spec: pickMeteredBackend('openai'),
      broker,
      streamText: fakeStreamText,
      modelFactory: (_k, m) => ({ id: m }),
    });
    const events: AgentEvent[] = [];
    for await (const e of new ProviderDriver({ engine }).run({ prompt: 'go', allowed_write_set: [] }, { cwd: '/tmp/x' })) events.push(e);
    expect(events.at(-1)!.kind).toBe('completion');
    expect(events.some((e) => e.summary.includes('metered:gpt-5.4'))).toBe(true);
  });
});

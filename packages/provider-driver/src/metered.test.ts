import { describe, it, expect } from 'vitest';
import { SecretBroker, staticSource } from '@gateloop/secret-broker';
import {
  METERED_BACKENDS,
  pickMeteredBackend,
  meteredHandleFor,
  createMeteredEngine,
} from './backends/metered';
import { ProviderDriver } from './providerDriver';
import type { AiSdkStreamText } from './aiSdkEngine';

// A fake AI-SDK streamText — exercises the AI-SDK-shaped boundary with NO real provider/network.
const fakeStreamText: AiSdkStreamText = ({ model }) => ({
  fullStream: (async function* () {
    // `model` is whatever modelFactory returned — assert the key reached the factory via it.
    yield { type: 'text-delta', text: `model=${(model as { id: string }).id}` };
    yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } };
  })(),
});

describe('STORY-035.2: metered key resolved through the Secret Broker (no plaintext to driver/core)', () => {
  it('resolves the key inside the engine-build closure and hands it ONLY to the injected factory', async () => {
    const broker = new SecretBroker(staticSource({ openai: 'sk-METERED-OPENAI-123456' }));
    let keySeenByFactory: string | undefined;
    const engine = await createMeteredEngine({
      spec: pickMeteredBackend('openai'),
      broker,
      streamText: fakeStreamText,
      modelFactory: (apiKey, modelId) => { keySeenByFactory = apiKey; return { id: modelId }; },
    });
    expect(engine.backendId).toBe('openai');
    expect(engine.model).toBe('gpt-5.4'); // default model
    // the key reached the factory (the real path: createOpenAI({apiKey})) ...
    expect(keySeenByFactory).toBe('sk-METERED-OPENAI-123456');
    // ... and the broker recorded it so it can be redacted everywhere downstream
    expect(broker.resolvedCount()).toBe(1);

    // Drive it: the key must NEVER appear in any emitted event (driver/core never see plaintext).
    const driver = new ProviderDriver({ engine, redact: (s) => broker.redact(s) });
    const events: string[] = [];
    for await (const e of driver.run({ prompt: 'go', allowed_write_set: [] }, { cwd: '/tmp/s' })) {
      events.push(JSON.stringify(e));
    }
    expect(events.join('\n')).not.toContain('sk-METERED-OPENAI-123456');
  });

  it('is multi-backend: each backend resolves its own key + model (router picks the model)', async () => {
    const broker = new SecretBroker(staticSource({ openai: 'sk-oai', anthropic: 'sk-ant' }));
    const mk = (id: string) => ({ id });
    const oai = await createMeteredEngine({ spec: pickMeteredBackend('openai'), broker, streamText: fakeStreamText, modelFactory: (_k, m) => mk(m) });
    const ant = await createMeteredEngine({ spec: pickMeteredBackend('anthropic'), model: 'claude-opus-4-8', broker, streamText: fakeStreamText, modelFactory: (_k, m) => mk(m) });
    expect(oai.model).toBe('gpt-5.4');
    expect(ant.backendId).toBe('anthropic');
    expect(ant.model).toBe('claude-opus-4-8'); // router-pinned model honored
    expect(broker.resolvedCount()).toBe(2);
  });

  it('handles are opaque (carry no plaintext) and registry/lookup are sane', () => {
    const h = meteredHandleFor(pickMeteredBackend('anthropic'));
    expect(h).toEqual({ handle_id: 'metered:anthropic', handle_type: 'metered_api_key', provider: 'anthropic' });
    expect(Object.keys(METERED_BACKENDS).sort()).toEqual(['anthropic', 'openai']);
    expect(() => pickMeteredBackend('nope')).toThrow(/unknown metered backend/);
  });

  it('fails loudly when the broker has no key (never silently proceeds without auth)', async () => {
    const broker = new SecretBroker(staticSource({}));
    await expect(createMeteredEngine({
      spec: pickMeteredBackend('openai'),
      broker,
      streamText: fakeStreamText,
      modelFactory: () => ({}),
    })).rejects.toThrow(/no metered key/);
  });
});

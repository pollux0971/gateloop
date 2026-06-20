import { describe, it, expect } from 'vitest';
import { SecretBroker, staticSource, meteredKeyHandle } from './index';

describe('STORY-035.2: meteredKeyHandle — opaque handle for a metered API key', () => {
  it('carries no plaintext, only how to find the key', () => {
    const h = meteredKeyHandle('openai');
    expect(h).toEqual({ handle_id: 'metered:openai', handle_type: 'metered_api_key', provider: 'openai' });
    expect(JSON.stringify(h)).not.toMatch(/sk-/);
  });

  it('the broker dereferences the handle to the key (the ONLY place plaintext appears) and can redact it', async () => {
    const broker = new SecretBroker(staticSource({ openai: 'sk-METERED-abcdef' }));
    const key = await broker.resolve(meteredKeyHandle('openai'));
    expect(key).toBe('sk-METERED-abcdef');
    expect(broker.resolvedCount()).toBe(1);
    expect(broker.redact('using sk-METERED-abcdef now')).toBe('using [REDACTED_SECRET] now');
  });
});

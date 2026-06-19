/**
 * Plan §2 key isolation — the Secret Broker: handle-only agent surface, single
 * dereference point, redaction, and a child-process source so the agent never reads
 * .env. Zero cost: static + temp-file sources, only a FAKE key.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SecretBroker, processEnvSource, subprocessEnvSource, staticSource,
  type SecretHandle,
} from './index';

const HANDLE: SecretHandle = { handle_id: 'provider.deepseek.default', handle_type: 'api_key', provider: 'deepseek' };

describe('secret-broker — handle-only resolution', () => {
  it('the handle carries NO plaintext; the value appears only from resolve()', async () => {
    const broker = new SecretBroker(staticSource({ deepseek: 'sk-FAKE-DEEPSEEK-0001' }));
    expect(JSON.stringify(HANDLE)).not.toMatch(/sk-FAKE/);     // handle is opaque
    const key = await broker.resolve(HANDLE);
    expect(key).toBe('sk-FAKE-DEEPSEEK-0001');                 // value only via the broker
    expect(broker.resolvedCount()).toBe(1);
  });

  it('redact scrubs every dereferenced secret from downstream text (trace guard)', async () => {
    const broker = new SecretBroker(staticSource({ deepseek: 'sk-FAKE-DEEPSEEK-0001', openai: 'sk-FAKE-OPENAI-0002' }));
    await broker.resolve(HANDLE);
    await broker.resolve({ handle_id: 'provider.openai.default', handle_type: 'api_key', provider: 'openai' });
    const log = 'calling model with key sk-FAKE-DEEPSEEK-0001 and sk-FAKE-OPENAI-0002 in headers';
    const safe = broker.redact(log);
    expect(safe).not.toMatch(/sk-FAKE/);
    expect(safe).toContain('[REDACTED_SECRET]');
  });

  it('processEnvSource reads <PROVIDER>_API_KEY from an injected env (operator shell)', async () => {
    const broker = new SecretBroker(processEnvSource({ DEEPSEEK_API_KEY: 'sk-FAKE-ENV-0003' } as NodeJS.ProcessEnv));
    expect(await broker.resolve(HANDLE)).toBe('sk-FAKE-ENV-0003');
  });
});

describe('secret-broker — subprocess source (agent never reads .env)', () => {
  const made: string[] = [];
  afterEach(() => { for (const f of made.splice(0)) fs.rmSync(f, { force: true }); });

  it('resolves the key in a CHILD process that sources the env file', async () => {
    const envFile = path.join(os.tmpdir(), `gl-broker-${process.pid}.env`);
    fs.writeFileSync(envFile, 'DEEPSEEK_API_KEY=sk-FAKE-SUBPROC-0004\nOTHER=x\n');
    made.push(envFile);
    const broker = new SecretBroker(subprocessEnvSource({ envFile }));
    // The broker's child sources the file and returns ONLY the value — this test never
    // reads the file itself (no fs.readFileSync of the env in the agent path).
    expect(await broker.resolve(HANDLE)).toBe('sk-FAKE-SUBPROC-0004');
  });

  it('a missing env file resolves to empty (clean), not a crash', async () => {
    const broker = new SecretBroker(subprocessEnvSource({ envFile: '/no/such/file.env' }));
    expect(await broker.resolve(HANDLE)).toBe('');
  });
});

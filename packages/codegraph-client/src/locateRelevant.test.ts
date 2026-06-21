import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { locateRelevantCode } from '@gateloop/codegraph-adapter';
import { engineClient, engineAvailable, buildIndex } from './index';

// STORY-CW.4 real-engine end-to-end: the adapter's locateRelevantCode, driven by the REAL engine
// client, locates a story's relevant files (write-set + real dependents). Local CPU, zero API.
const ENGINE = engineAvailable();
let ws = '';

describe.skipIf(!ENGINE)('STORY-CW.4: locateRelevantCode over the real engine', () => {
  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cw4eng-'));
    fs.writeFileSync(path.join(ws, 'slug.ts'), 'export function slugify(s: string){ return s.toLowerCase(); }\n');
    fs.writeFileSync(path.join(ws, 'consumer.ts'), "import { slugify } from './slug';\nexport function make(s: string){ return slugify(s); }\n");
    buildIndex(ws);
  });
  afterAll(() => { if (ws) fs.rmSync(ws, { recursive: true, force: true }); });

  it('fills relevant_files with the write-set file + its REAL dependent located by the engine', async () => {
    const r = await locateRelevantCode({ writeSetFiles: ['slug.ts'], symbols: ['slugify'] }, engineClient({ wsRoot: ws }));
    expect(r.relevant_files).toContain('slug.ts'); // the write-set file
    expect(r.relevant_files).toContain('consumer.ts'); // the real dependent
    expect(r.do_not_touch).toContain('consumer.ts');
    expect(r.codegraph_summary).toMatch(/relevant file/);
  });
});

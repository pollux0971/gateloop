/**
 * STORY-034.6 — READ-ONLY projection of a recorded CLI-mode (STORY-034.5) run trace.
 *
 * Loads the structured trace captured from the REAL 034.5 run + the REAL Layer-1/Layer-2
 * isolation proofs (see scripts/cli-mode-e2e/capture-cli-mode-trace.ts). This is a pure
 * read of an existing artifact — it triggers nothing and exposes no control that could
 * start a run or relax isolation. runId must match the recorded run (or "latest"); anything
 * else returns null, so there is no path traversal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = path.join(__dirname, '..', 'fixtures');

export function loadCliModeTrace(runId: string, fixturesDir: string = DEFAULT_FIXTURES): Record<string, unknown> | null {
  const trace = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'cli-mode-trace.json'), 'utf8')) as { run_id: string };
  return runId === 'latest' || runId === trace.run_id ? (trace as Record<string, unknown>) : null;
}

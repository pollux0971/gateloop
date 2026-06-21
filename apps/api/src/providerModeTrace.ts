/**
 * STORY-034.6 → EPIC-035 TIER C — READ-ONLY projection of a recorded provider-mode run trace.
 *
 * Loads the structured trace captured from the in-process provider-mode tool-layer pipeline +
 * the verified facts of the gated EPIC-035 (b) metered run (see scripts/capture-provider-mode-
 * trace.ts). This is a pure read of an existing artifact — it triggers nothing and exposes no
 * control that could start a run or relax isolation. runId must match the recorded run (or
 * "latest"); anything else returns null, so there is no path traversal.
 *
 * (Renamed from cliModeTrace.ts: the spawn-CLI cage trace was retired with the spawn path in
 * EPIC-035 TIER A/B; the cockpit now projects the in-process provider path.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = path.join(__dirname, '..', 'fixtures');

export function loadProviderModeTrace(runId: string, fixturesDir: string = DEFAULT_FIXTURES): Record<string, unknown> | null {
  const trace = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'provider-mode-trace.json'), 'utf8')) as { run_id: string };
  return runId === 'latest' || runId === trace.run_id ? (trace as Record<string, unknown>) : null;
}

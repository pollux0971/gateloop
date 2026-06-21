/**
 * @gateloop/codegraph-adapter
 *
 * Wraps the CodeGraph MCP server for harness use. Read-only; no write path,
 * no secrets, no network needed in tests — inject a CodeGraphClient fixture.
 *
 * Architecture: gateloop/docs/architecture/06_CODEGRAPH_INTEGRATION.md
 */

export type CodeGraphOperation =
  | 'symbol_lookup'
  | 'impact'
  | 'dependents'
  | 'dependencies'
  | 'callgraph';

export interface CodeGraphQuery {
  operation: CodeGraphOperation;
  target: string;
  /** Glob patterns the agent is allowed to read (from the story contract). */
  readScope?: string[];
}

export interface SymbolLocation {
  file: string;
  line: number;
  column?: number;
  kind?: 'definition' | 'reference';
}

export interface CodeGraphResult {
  operation: CodeGraphOperation;
  target: string;
  locations: SymbolLocation[];
  /** File paths in the impact/dependent/dependency set. */
  impactedFiles: string[];
  /** Compact, ≤200 chars — injected into context. Never raw file content. */
  summary: string;
}

export interface CodeGraphClient {
  query(q: CodeGraphQuery): Promise<{
    locations?: { file: string; line: number; column?: number; kind?: string }[];
    impacted_files?: string[];
  }>;
}

/** CI-safe no-op client — use when the real MCP server is unavailable. */
export const NULL_CLIENT: CodeGraphClient = {
  async query(_q) { return { locations: [], impacted_files: [] }; },
};

function globMatch(globs: string[], p: string): boolean {
  return globs.some(g => {
    const re = new RegExp(
      '^' +
      g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
       .replace(/\*\*/g, '§')
       .replace(/\*/g, '[^/]*')
       .replace(/§/g, '.*') +
      '$'
    );
    return re.test(p);
  });
}

/** Filter locations to those within the agent's read scope. */
export function filterToReadScope(
  locations: SymbolLocation[],
  readScope: string[],
): SymbolLocation[] {
  if (readScope.length === 0) return locations;
  return locations.filter(l => globMatch(readScope, l.file));
}

function truncateSummary(s: string): string {
  return s.length <= 200 ? s : s.slice(0, 197) + '...';
}

/** Look up symbol definitions and references. */
export async function lookupSymbol(
  symbol: string,
  client: CodeGraphClient = NULL_CLIENT,
  readScope?: string[],
): Promise<CodeGraphResult> {
  const raw = await client.query({ operation: 'symbol_lookup', target: symbol, readScope });
  const allLocs: SymbolLocation[] = (raw.locations ?? []).map(l => ({
    file: l.file,
    line: l.line,
    ...(l.column !== undefined && { column: l.column }),
    ...(l.kind !== undefined && { kind: l.kind as SymbolLocation['kind'] }),
  }));
  const locations = readScope && readScope.length > 0
    ? filterToReadScope(allLocs, readScope)
    : allLocs;
  const defs = locations.filter(l => l.kind === 'definition').length;
  const refs = locations.filter(l => l.kind === 'reference').length;
  const summary = truncateSummary(
    `symbol '${symbol}': ${defs} definition${defs !== 1 ? 's' : ''}, ${refs} reference${refs !== 1 ? 's' : ''}`,
  );
  return { operation: 'symbol_lookup', target: symbol, locations, impactedFiles: [], summary };
}

/** Compute the impact set (dependents) for a proposed write-set. */
export async function computeImpactSet(
  files: string[],
  client: CodeGraphClient = NULL_CLIENT,
  readScope?: string[],
): Promise<CodeGraphResult> {
  const target = files.join(',');
  const raw = await client.query({ operation: 'impact', target, readScope });
  const allImpacted = raw.impacted_files ?? [];
  const impactedFiles = readScope && readScope.length > 0
    ? allImpacted.filter(f => globMatch(readScope, f))
    : allImpacted;
  const summary = truncateSummary(
    `impact set for ${files.length} file${files.length !== 1 ? 's' : ''}: ${impactedFiles.length} dependent${impactedFiles.length !== 1 ? 's' : ''}`,
  );
  return { operation: 'impact', target, locations: [], impactedFiles, summary };
}

/**
 * Extract the compact summary for context injection.
 * Never returns raw file content — only the pre-built summary string.
 */
export function summarizeForContext(result: CodeGraphResult): string {
  return result.summary;
}

// ── STORY-CW.4: locate the code relevant to a story (Mode 1, the context root) ───────

/** Pull likely symbol names out of a story's prose: backtick-quoted idents + camel/PascalCase. */
export function extractSymbolHints(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_$][\w$]*)`/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9_$]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9_$]*)\b/g)) out.add(m[1]);
  return [...out];
}

export interface RelevantCodeInput {
  /** Concrete file paths the story will touch (its write-set, files only — globs/dirs skipped). */
  writeSetFiles: string[];
  /** Symbol-name hints the story names (e.g. from extractSymbolHints over the objective/behaviors). */
  symbols?: string[];
}

export interface RelevantCode {
  /** Files relevant to the story: its own write-set + located symbol files + blast-radius dependents. */
  relevant_files: string[];
  /** Dependents OUTSIDE the write-set the developer must preserve (do-not-touch). */
  do_not_touch: string[];
  /** Compact, ≤200-char summary for the developer packet's codegraph_summary section. */
  codegraph_summary: string;
}

/**
 * Locate the code relevant to a story via codegraph BEFORE the Supervisor dispatches it — the
 * fix for "context selection is by role, not code-relevance" (the empty relevant_files section).
 * Pure over an injected `CodeGraphClient`: `symbol_lookup` for the named symbols' definitions and
 * `impact` (blast radius) for the write-set files. With NULL_CLIENT (no engine) it degrades to the
 * write-set itself (still non-empty), so the seam/fallback holds; with the real engine it adds the
 * located related files + dependents. Deterministic (sorted, deduped).
 */
export async function locateRelevantCode(
  input: RelevantCodeInput,
  client: CodeGraphClient = NULL_CLIENT,
): Promise<RelevantCode> {
  const relevant = new Set<string>(input.writeSetFiles);
  for (const sym of input.symbols ?? []) {
    const r = await lookupSymbol(sym, client);
    for (const loc of r.locations) relevant.add(loc.file);
  }
  const impact = input.writeSetFiles.length > 0 ? await computeImpactSet(input.writeSetFiles, client) : null;
  const dependents = impact ? impact.impactedFiles.filter((f) => !input.writeSetFiles.includes(f)) : [];
  for (const f of dependents) relevant.add(f);

  const relevant_files = [...relevant].sort();
  const do_not_touch = [...new Set(dependents)].sort();
  const located = relevant_files.length - input.writeSetFiles.filter((f) => relevant.has(f)).length;
  const summary =
    do_not_touch.length === 0 && located <= 0
      ? `codegraph: ${relevant_files.length} relevant file(s) (write-set; no extra related code located)`
      : `codegraph: ${relevant_files.length} relevant file(s)` +
        (do_not_touch.length ? `; preserve ${do_not_touch.length} dependent(s): ${do_not_touch.slice(0, 3).join(', ')}` : '');
  return { relevant_files, do_not_touch, codegraph_summary: truncateSummary(summary) };
}

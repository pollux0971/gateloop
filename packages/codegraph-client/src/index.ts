/**
 * @gateloop/codegraph-client — the REAL codegraph engine client (EPIC-CW).
 *
 * The engine (@colbymchenry/codegraph, MIT, local-first SQLite, 20+ languages) is an
 * implementation detail HIDDEN BEHIND the @gateloop/codegraph-adapter seam: this package
 * imports only the adapter's `CodeGraphClient` interface, and the core (provider-driver,
 * harness-core, supervisor) never imports the engine — it sees only the seam. CI falls back
 * to `fixtureClient`; a self-built engine (Option C) could slot in behind the same interface.
 *
 * STORY-CW.1 deliverable: ROBUST binary resolution (PATH / npx / config override — explicitly
 * NOT the dead client's hardcoded `/data/python/codegraph_engine/...` path) + a real-index smoke
 * that proves the engine is usable from GateLoop (build a `.codegraph/` index over a fixture repo,
 * run a query, get structured JSON back). All local (host CPU), zero API cost. CW.2 maps the full
 * adapter operation set over this resolver/runner.
 *
 * Design: docs/architecture/22_CODEGRAPH_WIRING.md
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CodeGraphClient } from '@gateloop/codegraph-adapter';

// ── Robust binary resolution (the anti-hardcoded-path fix) ───────────────────────────

export type BinSource = 'env' | 'path' | 'npx';

/** A resolved engine invocation: `command` + a fixed `baseArgs` prefix. NEVER a hardcoded path. */
export interface ResolvedBin {
  command: string;
  baseArgs: string[];
  source: BinSource;
}

/** Locate an executable on PATH (cross-platform). Returns the first hit or null. */
function which(cmd: string, env: NodeJS.ProcessEnv): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf8', env });
  if (r.status === 0 && r.stdout) {
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
  }
  return null;
}

/**
 * Resolve the codegraph engine invocation with NO hardcoded path (the dead client's
 * `engineCodegraph` pointed at a fixed `.../dist/bin/codegraph.js` that didn't exist — the exact
 * anti-pattern this story avoids). Resolution order:
 *   1. explicit `CODEGRAPH_BIN` override (a binary, or a `.js` run via the current node);
 *   2. `codegraph` on PATH (the normal install — e.g. ~/.local/bin/codegraph — but discovered, not assumed);
 *   3. `npx @colbymchenry/codegraph` (zero-install fallback).
 * Returns null when nothing is resolvable (callers fall back to the fixture/NULL client).
 */
export function resolveCodegraphBin(env: NodeJS.ProcessEnv = process.env): ResolvedBin | null {
  const override = env.CODEGRAPH_BIN?.trim();
  if (override) {
    return override.endsWith('.js')
      ? { command: process.execPath, baseArgs: [override], source: 'env' }
      : { command: override, baseArgs: [], source: 'env' };
  }
  const onPath = which('codegraph', env);
  if (onPath) return { command: onPath, baseArgs: [], source: 'path' };
  if (which('npx', env)) return { command: 'npx', baseArgs: ['--yes', '@colbymchenry/codegraph'], source: 'npx' };
  return null;
}

// ── Low-level engine runner (local subprocess; telemetry off; no network at query time) ──

export interface EngineRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run the resolved engine with `args` in `cwd`. Telemetry disabled; bounded by a timeout. */
export function runEngine(bin: ResolvedBin, args: string[], cwd: string, timeoutMs = 120_000): EngineRunResult {
  const r = spawnSync(bin.command, [...bin.baseArgs, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, CODEGRAPH_TELEMETRY: '0' },
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

/** Is the engine resolvable AND runnable (a real `--version` like `0.9.5` comes back)? Local, free. */
export function engineAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const bin = resolveCodegraphBin(env);
  if (!bin) return false;
  const r = runEngine(bin, ['--version'], process.cwd(), 15_000);
  return r.ok && /\d+\.\d+/.test(r.stdout);
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return null;
  }
}

// ── Index + query primitives (used by the smoke; CW.2 maps the adapter ops over these) ──

/** Build (or incrementally update) the `.codegraph/` index for `wsRoot`. Local CPU, zero API. */
export function buildIndex(wsRoot: string, bin: ResolvedBin = mustResolve()): EngineRunResult {
  const hasIndex = fs.existsSync(path.join(wsRoot, '.codegraph'));
  // CW.1: first build via `init --index`; incremental `sync` thereafter. CW.3 owns the full lifecycle.
  return hasIndex ? runEngine(bin, ['sync', wsRoot], wsRoot) : runEngine(bin, ['init', wsRoot, '--index'], wsRoot);
}

/** One engine node from `query <search> --json` (the subset the harness uses). */
export interface EngineNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName?: string;
  filePath: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  signature?: string | null;
  isExported?: boolean;
}

/** Raw symbol search: `codegraph query <search> --json` → the matched nodes (scored). */
export function queryRaw(wsRoot: string, search: string, bin: ResolvedBin = mustResolve()): EngineNode[] {
  const r = runEngine(bin, ['query', search, '--json'], wsRoot);
  const parsed = parseJson(r.stdout);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) => (row && typeof row === 'object' ? (row as { node?: EngineNode }).node : undefined))
    .filter((n): n is EngineNode => !!n && typeof n.filePath === 'string' && typeof n.name === 'string');
}

export interface IndexStatus {
  initialized: boolean;
  fileCount?: number;
  nodeCount?: number;
  edgeCount?: number;
}

/** `codegraph status --json` → the index statistics (proves the index exists + is populated). */
export function indexStatus(wsRoot: string, bin: ResolvedBin = mustResolve()): IndexStatus {
  const r = runEngine(bin, ['status', wsRoot, '--json'], wsRoot);
  const parsed = parseJson(r.stdout);
  if (parsed && typeof parsed === 'object') return parsed as IndexStatus;
  return { initialized: false };
}

function mustResolve(): ResolvedBin {
  const bin = resolveCodegraphBin();
  if (!bin) {
    throw new Error(
      'codegraph engine not resolvable — set CODEGRAPH_BIN, install `codegraph` on PATH, or provide npx ' +
        '(this is the robust resolution; there is intentionally NO hardcoded fallback path)',
    );
  }
  return bin;
}

// ── The real-index smoke (STORY-CW.1: "prove the engine is usable from GateLoop") ──

export interface IndexSmokeResult {
  resolved: ResolvedBin;
  indexBuilt: boolean;
  statusInitialized: boolean;
  nodeCount: number;
  /** A query that returned structured JSON nodes (proves query works end-to-end). */
  queriedSymbol: string;
  queryHitFiles: string[];
}

/**
 * Build an index over `wsRoot`, then run a real query + status and confirm structured JSON comes
 * back. This is where "the engine is actually usable from GateLoop" is proven — all local, zero API.
 */
export function indexSmoke(wsRoot: string, querySymbol: string, bin: ResolvedBin = mustResolve()): IndexSmokeResult {
  const built = buildIndex(wsRoot, bin);
  const status = indexStatus(wsRoot, bin);
  const nodes = queryRaw(wsRoot, querySymbol, bin);
  return {
    resolved: bin,
    indexBuilt: built.ok,
    statusInitialized: status.initialized === true,
    nodeCount: status.nodeCount ?? 0,
    queriedSymbol: querySymbol,
    queryHitFiles: [...new Set(nodes.map((n) => n.filePath))],
  };
}

// ── CI fixture client (implements the adapter seam; no engine) ──────────────────────

/** A `CodeGraphClient` the harness can use without the engine — known impact + located symbols. */
export interface FixtureSpec {
  /** file → dependent files (for `impact`). */
  impact?: Record<string, string[]>;
  /** symbol → locations (for `symbol_lookup`). */
  symbols?: Record<string, { file: string; line: number; kind?: string }[]>;
}

export interface GateloopCodegraphClient extends CodeGraphClient {
  readonly backend: string;
}

/** CI-safe fixture client. Proves the seam wiring without the engine; swappable to the real client. */
export function fixtureClient(spec: FixtureSpec = {}): GateloopCodegraphClient {
  return {
    backend: 'fixture',
    async query(q) {
      if (q.operation === 'impact') {
        const impacted = new Set<string>();
        for (const f of q.target.split(',').map((s) => s.trim()).filter(Boolean)) {
          for (const dep of spec.impact?.[f] ?? []) impacted.add(dep);
        }
        return { locations: [], impacted_files: [...impacted] };
      }
      if (q.operation === 'symbol_lookup') {
        const locs = (spec.symbols?.[q.target] ?? []).map((l) => ({ file: l.file, line: l.line, kind: l.kind }));
        return { locations: locs, impacted_files: [] };
      }
      return { locations: [], impacted_files: [] };
    },
  };
}

// ── STORY-CW.2: all adapter ops over the real engine (revive symbol_lookup) ──────────

/** A graph node as returned by impact/callers/callees. */
export interface RelatedNode {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
}

/** Exported symbol names of an ESM source file (to drive symbol-level impact over a file set). */
export function exportedSymbols(content: string): string[] {
  const out = new Set<string>();
  const re = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.add(m[1]);
  const re2 = /export\s*\{([^}]*)\}/g;
  while ((m = re2.exec(content)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return [...out];
}

/** `codegraph impact <symbol> --json` → the transitively affected nodes (blast radius). */
export function impactRaw(wsRoot: string, symbol: string, bin: ResolvedBin = mustResolve(), depth = 2): RelatedNode[] {
  const r = runEngine(bin, ['impact', symbol, '--json', '--depth', String(depth)], wsRoot);
  const p = parseJson(r.stdout) as { affected?: RelatedNode[] } | null;
  return Array.isArray(p?.affected) ? p!.affected.filter((n) => n && typeof n.filePath === 'string') : [];
}

/** `codegraph callers <symbol> --json` → the call sites (references / dependents). */
export function callersRaw(wsRoot: string, symbol: string, bin: ResolvedBin = mustResolve()): RelatedNode[] {
  const r = runEngine(bin, ['callers', symbol, '--json'], wsRoot);
  const p = parseJson(r.stdout) as { callers?: RelatedNode[] } | null;
  return Array.isArray(p?.callers) ? p!.callers.filter((n) => n && typeof n.filePath === 'string') : [];
}

/** `codegraph callees <symbol> --json` → the outbound calls (dependencies). */
export function calleesRaw(wsRoot: string, symbol: string, bin: ResolvedBin = mustResolve()): RelatedNode[] {
  const r = runEngine(bin, ['callees', symbol, '--json'], wsRoot);
  const p = parseJson(r.stdout) as { callees?: RelatedNode[] } | null;
  return Array.isArray(p?.callees) ? p!.callees.filter((n) => n && typeof n.filePath === 'string') : [];
}

const DEFINITION_KINDS = new Set(['function', 'class', 'method', 'const', 'variable', 'interface', 'type', 'enum']);
function nodeKindToLoc(kind: string | undefined): 'definition' | 'reference' {
  return kind && DEFINITION_KINDS.has(kind) ? 'definition' : 'reference';
}
const uniq = (xs: string[]) => [...new Set(xs)];

export interface EngineClientOptions {
  wsRoot: string;
  bin?: ResolvedBin;
}

/**
 * A `CodeGraphClient` backed by the REAL engine — every adapter operation mapped to the engine's
 * `--json` commands (STORY-CW.2). Passing this to the adapter's `lookupSymbol`/`computeImpactSet`
 * makes them run over the real engine instead of the NULL stub. The engine stays a subprocess
 * behind the seam; CI without an engine keeps using NULL_CLIENT / fixtureClient.
 *   symbol_lookup → query (locate symbol → file:line)
 *   impact        → per-file exported symbols → impact (blast radius)
 *   dependents    → callers (who references it)
 *   dependencies  → callees (what it calls)
 *   callgraph     → callers ∪ callees
 */
export function engineClient(opts: EngineClientOptions): GateloopCodegraphClient {
  const bin = opts.bin ?? mustResolve();
  const ws = opts.wsRoot;
  return {
    backend: `engine:${bin.source}`,
    async query(q) {
      switch (q.operation) {
        case 'symbol_lookup': {
          const locations = queryRaw(ws, q.target, bin)
            .filter((n) => n.name === q.target)
            .map((n) => ({ file: n.filePath, line: n.startLine ?? 0, kind: nodeKindToLoc(n.kind) }));
          return { locations, impacted_files: [] };
        }
        case 'impact': {
          const files = q.target.split(',').map((s) => s.trim()).filter(Boolean);
          const impacted = new Set<string>();
          for (const f of files) {
            const abs = path.join(ws, f);
            if (!fs.existsSync(abs)) continue;
            for (const sym of exportedSymbols(fs.readFileSync(abs, 'utf8'))) {
              for (const a of impactRaw(ws, sym, bin)) {
                if (a.filePath && !files.includes(a.filePath)) impacted.add(a.filePath);
              }
            }
          }
          return { locations: [], impacted_files: [...impacted] };
        }
        case 'dependents': {
          const callers = callersRaw(ws, q.target, bin);
          return {
            locations: callers.map((c) => ({ file: c.filePath, line: c.startLine ?? 0, kind: 'reference' })),
            impacted_files: uniq(callers.map((c) => c.filePath)),
          };
        }
        case 'dependencies': {
          const callees = calleesRaw(ws, q.target, bin);
          return {
            locations: callees.map((c) => ({ file: c.filePath, line: c.startLine ?? 0, kind: 'reference' })),
            impacted_files: uniq(callees.map((c) => c.filePath)),
          };
        }
        case 'callgraph': {
          const both = [...callersRaw(ws, q.target, bin), ...calleesRaw(ws, q.target, bin)];
          return {
            locations: both.map((c) => ({ file: c.filePath, line: c.startLine ?? 0, kind: 'reference' })),
            impacted_files: uniq(both.map((c) => c.filePath)),
          };
        }
        default:
          return { locations: [], impacted_files: [] };
      }
    },
  };
}

// ── STORY-CW.3: index lifecycle (explicit, no watcher) + `.codegraph/` exclusion ─────

/** The engine's index directory — harness state, never agent output. */
export const CODEGRAPH_DIR = '.codegraph';

/**
 * Args for the Step-0 index build (run once at run start, in the disposable workspace).
 * EXPLICIT `init --index` — deliberately NO `--watch`/`serve`: the harness drives the index on a
 * known schedule (Step 0 + checkpoint), not via a background file-watcher that can silently lag.
 */
export function step0IndexArgs(wsRoot: string): string[] {
  return ['init', wsRoot, '--index'];
}

/** Args for an explicit incremental sync after a checkpoint. Again EXPLICIT — never a watcher. */
export function checkpointSyncArgs(wsRoot: string): string[] {
  return ['sync', wsRoot];
}

/** True iff the args use a background/long-running mode (watch/serve) — which the harness forbids. */
export function usesBackgroundWatcher(args: string[]): boolean {
  return args.some((a) => /^(--watch|-w|watch|serve|--serve|--mcp)$/.test(a));
}

/** Step-0 build of the workspace index (explicit, local CPU, zero API). */
export function step0BuildIndex(wsRoot: string, bin: ResolvedBin = mustResolve()): EngineRunResult {
  return runEngine(bin, step0IndexArgs(wsRoot), wsRoot);
}

/** Explicit incremental sync after a checkpoint changed indexed files (no watcher). */
export function checkpointSync(wsRoot: string, bin: ResolvedBin = mustResolve()): EngineRunResult {
  return runEngine(bin, checkpointSyncArgs(wsRoot), wsRoot);
}

/**
 * Keep `.codegraph/` out of git for a workspace by appending it to `.git/info/exclude` (LOCAL,
 * untracked — never appears in a diff itself, needs no baseline commit). After this, `git add -A`
 * skips the index, so it never enters the exit-gate diff (`collectDiffAgainstHead`) or the agent
 * write-set. Idempotent. (workspace-manager exposes the same via `excludeFromWorkspace`; this
 * standalone variant is for callers that hold only a path, not a WorkspaceManifest.)
 */
export function excludeCodegraphFromGit(wsRoot: string): void {
  const excludePath = path.join(wsRoot, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.join(wsRoot, '.git'))) return; // not a git workspace — nothing to exclude
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const entry = `${CODEGRAPH_DIR}/`;
  if (existing.split('\n').map((l) => l.trim()).includes(entry)) return;
  fs.writeFileSync(excludePath, (existing && !existing.endsWith('\n') ? existing + '\n' : existing) + entry + '\n');
}

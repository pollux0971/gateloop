/**
 * STORY-TRUST.5 + STORY-TRUST.6 — phantom-defense honesty sweep (reproducible, widened).
 *
 * The INVERSE of the usual set≠effective proof: EPIC-TRUST REMOVED execution-side walls and
 * the skill test-gate, so the proof is the ABSENCE of phantom defenses. This sweep scans
 * ALL source (docs + ADRs + apps + packages + scripts + tests + the two plans) for affirmative,
 * present-tense claims that a retired protection still EXISTS:
 *   - execution-side WALL claims (sandbox/egress/isolation/container as the boundary), and
 *   - skill TEST-GATE / validation claims (a skill must pass tests / be validated to register).
 *
 * STORY-TRUST.6 meta-fix: TRUST.5's original sweep scanned ONLY docs/, so the test-gate's
 * apps/ surfaces were invisible — a "0 phantom" that excluded apps/ is itself the trap the
 * operator's rule guards against. Widening the scope is the fix, not just patching symptoms.
 *
 * A phantom phrase is allowed ONLY if its own file ALSO carries an ADR-0013 disclaimer
 * (retired / operator-trust / unvalidated / optional self-check / no execution-side wall /
 * tombstone). A file that AFFIRMS a retired protection without disclaiming it is a phantom.
 *
 * Pure read-only; no network, no secrets. Importable (returns violations) and runnable
 * (prints + exits non-zero on any violation — never `|| true`, never an echo placeholder).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Affirmative, present-tense execution-side WALL claims (TRUST.5 class). */
const PHANTOM_WALL = [
  /sandbox is the (sole|only) (trust )?(boundary|wall)/i,
  /沙箱(是|為)[\s\S]{0,8}唯一[\s\S]{0,6}(牆|邊界)/,
  /沙箱牆[\s\S]{0,8}(有效|證明)/,
  /(egress|沙箱)[\s\S]{0,12}(cage|牢籠)[\s\S]{0,8}(proven|有效|enforce|證明)/i,
  /prove-egress[\s\S]{0,24}(proves|證明)[\s\S]{0,8}(wall|牆|有效)/i,
  /執行端[\s\S]{0,6}(有|存在)[\s\S]{0,6}(硬牆|沙箱牆)/,
];

/** Affirmative, present-tense skill TEST-GATE / validation claims (TRUST.6 class). */
const PHANTOM_TEST_GATE = [
  /must pass the (lifecycle )?test-gate/i,
  /awaiting (the )?test-gate/i,
  /skill[\s\S]{0,24}(must|requires?|has to)[\s\S]{0,16}tests?[\s\S]{0,16}(to |before )?regist/i,
  /(cannot|can't) be registered[\s\S]{0,30}(without|unless|no|missing)[\s\S]{0,12}tests?/i,
  /registration[\s\S]{0,16}requires[\s\S]{0,16}tests?/i,
  /tests?[\s\S]{0,8}gate[\s\S]{0,8}registration/i,
];

/** ADR-0013 disclaimer markers — their presence means the phrase is honestly framed as gone. */
const DISCLAIMER =
  /no execution-side wall|ADR-0013|已刪除|已作廢|已被取代|superseded|不要沙箱|no sandbox|沒有硬牆|operator-trust|operator-complete-trust|test-gate (is )?retired|retired[\s\S]{0,20}test-gate|optional self-check|unvalidated|not a gate|never a gate|hygiene, not a wall|registers? (as-is|active|unvalidated)/i;

export type PhantomClass = 'execution-wall' | 'test-gate';
export interface PhantomViolation { file: string; cls: PhantomClass; phrase: string }

const SKIP_DIR = /(^|\/)(node_modules|dist|\.git|\.codegraph|coverage)(\/|$)/;
const SCAN_EXT = /\.(md|ts|tsx|js|jsx|yaml|yml|json)$/;

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP_DIR.test(p)) continue;
    if (e.isDirectory()) walk(p, acc);
    else if (SCAN_EXT.test(e.name) && !/\.js\.map$|\.tsbuildinfo$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/**
 * Scan ALL source under the gateloop root for undisclaimed phantom claims (both classes).
 * Returns the violations list (empty = honest). STORY-TRUST.6 widened the scope from docs-only
 * to: docs, ADR, apps, packages, scripts, tests, plus the two plan files.
 */
export function sweepPhantomClaims(repoRoot: string): PhantomViolation[] {
  const roots = ['docs', 'ADR', 'apps', 'packages', 'scripts', 'tests'];
  const files = [
    ...roots.flatMap(r => walk(path.join(repoRoot, r))),
    path.join(repoRoot, 'GATELOOP_REALIGNMENT_PLAN.md'),
    path.join(repoRoot, 'GATELOOP_FRONTEND_PLAN.md'),
  ].filter(f => fs.existsSync(f));

  const violations: PhantomViolation[] = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (DISCLAIMER.test(text)) continue; // any phantom phrase here is honestly disclaimed
    const rel = path.relative(repoRoot, f);
    const check = (res: RegExp[], cls: PhantomClass) => {
      for (const re of res) {
        const m = text.match(re);
        if (m) violations.push({ file: rel, cls, phrase: m[0].replace(/\s+/g, ' ').slice(0, 70) });
      }
    };
    check(PHANTOM_WALL, 'execution-wall');
    check(PHANTOM_TEST_GATE, 'test-gate');
  }
  return violations;
}

/** Back-compat alias for STORY-TRUST.5's import (the sweep now covers both phantom classes). */
export const sweepPhantomWallClaims = sweepPhantomClaims;

// Runnable entry: print + exit non-zero on any violation (no || true, no skip, no placeholder).
const isMain = (() => { try { return process.argv[1] && fs.realpathSync(process.argv[1]).endsWith('honesty-sweep.ts'); } catch { return false; } })();
if (isMain) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const v = sweepPhantomClaims(repoRoot);
  if (v.length === 0) {
    console.log('honesty sweep (widened to all source): 0 phantom claims — no undisclaimed execution-wall OR test-gate claim.');
  } else {
    console.error(`honesty sweep FAILED: ${v.length} undisclaimed phantom claim(s):`);
    for (const x of v) console.error(`  - [${x.cls}] ${x.file}: "${x.phrase}"`);
    process.exit(1);
  }
}

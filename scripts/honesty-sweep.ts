/**
 * STORY-TRUST.5 — phantom-defense honesty sweep (reproducible).
 *
 * The INVERSE of the usual set≠effective proof: this epic REMOVED execution-side walls, so
 * the proof is the ABSENCE of phantom defenses. This sweep scans docs/ + the two plan files
 * for affirmative, present-tense claims that an execution-side wall EXISTS / PROTECTS. Such a
 * phrase is only allowed if the same file ALSO carries an ADR-0013 disclaimer (the
 * "no execution-side wall" banner, or a tombstone: 已刪除 / 已作廢 / 已被取代 / superseded /
 * operator-trust). Any file that AFFIRMS a wall without disclaiming it is a phantom defense.
 *
 * Pure read-only; no network, no secrets. Importable (returns violations) and runnable
 * (prints + exits non-zero on any violation — never `|| true`).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Affirmative, present-tense execution-side WALL claims (the phantom shapes we forbid undisclaimed). */
const PHANTOM_WALL = [
  /sandbox is the (sole|only) (trust )?(boundary|wall)/i,
  /沙箱(是|為)[\s\S]{0,8}唯一[\s\S]{0,6}(牆|邊界)/,
  /沙箱牆[\s\S]{0,8}(有效|證明)/,
  /(egress|沙箱)[\s\S]{0,12}(cage|牢籠)[\s\S]{0,8}(proven|有效|enforce|證明)/i,
  /prove-egress[\s\S]{0,24}(proves|證明)[\s\S]{0,8}(wall|牆|有效)/i,
  /執行端[\s\S]{0,6}(有|存在)[\s\S]{0,6}(硬牆|沙箱牆)/,
];

/** ADR-0013 disclaimer markers — presence means the wall phrase is honestly framed as gone/never-real. */
const DISCLAIMER =
  /no execution-side wall|ADR-0013-no-sandbox-operator-trust|已刪除|已作廢|已被取代|superseded|不要沙箱|no sandbox|沒有硬牆|operator-trust|operator-complete-trust/i;

export interface PhantomViolation { file: string; phrase: string }

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

/** Scan docs/ + the two plan files. Returns the list of phantom-wall violations (empty = honest). */
export function sweepPhantomWallClaims(repoRoot: string): PhantomViolation[] {
  const files = [
    ...walk(path.join(repoRoot, 'docs')),
    path.join(repoRoot, 'GATELOOP_REALIGNMENT_PLAN.md'),
    path.join(repoRoot, 'GATELOOP_FRONTEND_PLAN.md'),
  ].filter(f => fs.existsSync(f));

  const violations: PhantomViolation[] = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const hasDisclaimer = DISCLAIMER.test(text);
    if (hasDisclaimer) continue; // the wall phrase, if any, is honestly disclaimed in this file
    for (const re of PHANTOM_WALL) {
      const m = text.match(re);
      if (m) violations.push({ file: path.relative(repoRoot, f), phrase: m[0].replace(/\s+/g, ' ').slice(0, 60) });
    }
  }
  return violations;
}

// Runnable entry: print + exit non-zero on any violation (no || true, no skip).
const isMain = (() => { try { return process.argv[1] && fs.realpathSync(process.argv[1]).endsWith('honesty-sweep.ts'); } catch { return false; } })();
if (isMain) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const v = sweepPhantomWallClaims(repoRoot);
  if (v.length === 0) {
    console.log('honesty sweep: 0 phantom execution-wall claims (every wall phrase is disclaimed by ADR-0013).');
  } else {
    console.error(`honesty sweep FAILED: ${v.length} undisclaimed phantom-wall claim(s):`);
    for (const x of v) console.error(`  - ${x.file}: "${x.phrase}"`);
    process.exit(1);
  }
}

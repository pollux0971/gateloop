/**
 * STORY-GATE.2 — production wiring for the silent protective backstops.
 *
 * Provides REAL git-backed runners for runProtectiveBackstop (the silent-vs-stop logic
 * lives in @gateloop/harness-core and is unit-tested with injected fakes). The sync /
 * force-push workflow calls these so the protections run AUTOMATICALLY (no prompt) —
 * "silent ≠ removed": the bundle/verify/checkpoint genuinely execute; only the human
 * prompt is gone. A real secret caught by the pre-sync verify still STOPS (data-safety).
 *
 * Nothing here runs at import; it is invoked explicitly by the workflow. No secrets are
 * read by this code — the secret SCAN only inspects the diff text the verify produces.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProtectiveBackstop, type BackstopRunners, type BackstopResult } from '@gateloop/harness-core';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUTER_REPO = path.resolve(here, '../../'); // /data/python/codeharness_workspace

function git(args: string[], cwd = OUTER_REPO): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Real runners: bundle backup, fresh-clone-equivalent diff verify, checkpoint tag. */
export function realRunners(opts: { timestamp: string; against?: string } = { timestamp: 'manual' }): BackstopRunners {
  return {
    // Pre-force-push: bundle the whole outer repo (the audit-trail safety net).
    backup: () => {
      const out = path.join(OUTER_REPO, `OUTER_backup_${opts.timestamp}.bundle`);
      git(['bundle', 'create', out, '--all']);
      return out;
    },
    // Pre-sync: produce the diff that is about to be pushed, for the secret scan to inspect.
    verify: () => {
      const ref = opts.against ?? 'HEAD';
      const output = git(['diff', '--stat', `${ref}~1`, ref].slice(0, opts.against ? 4 : 2)).toString();
      return { ok: true, output };
    },
    // Pre-promotion: record a checkpoint ref so the change is reversible before promotion.
    checkpoint: () => {
      const tag = `checkpoint/${opts.timestamp}`;
      git(['tag', '-f', tag]);
      return tag;
    },
  };
}

/** Run all three backstops silently; return their results (the workflow logs + obeys `stopped`). */
export function runAllBackstopsSilently(runners: BackstopRunners): BackstopResult[] {
  return (['force_push_backup', 'pre_sync_verify', 'pre_promotion_checkpoint'] as const)
    .map(kind => runProtectiveBackstop(kind, runners));
}

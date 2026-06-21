/**
 * STORY-GATE.2 — protective backstops run SILENTLY (ADR-025 class 3).
 *
 * A backstop that protects the USER from an accident (back up before a force-push,
 * verify before a sync, checkpoint before a promotion) does not gate the user's
 * DECISION, so it must not interrupt with a prompt. It runs automatically, logs what it
 * did, and continues.
 *
 * The one exception is itself a guardrail: if a backstop CATCHES a real danger — the
 * pre-sync secret scan finds a real key about to be pushed — it STOPS. That is
 * data-safety, not approval friction. "Silent" describes the backstop *running*; a
 * backstop *catching something* still stops.
 *
 * Pure + deterministic: the side-effecting work (git bundle, fresh clone, checkpoint) is
 * INJECTED as runners, so the silent-vs-stop logic is provable with no git, no network.
 * "Silent ≠ removed": the runner is still invoked — only the human prompt is gone.
 */

export type BackstopKind = 'force_push_backup' | 'pre_sync_verify' | 'pre_promotion_checkpoint';

export interface BackstopResult {
  kind: BackstopKind;
  /** The protection actually executed (silent ≠ removed — it still runs). */
  ran: boolean;
  /** It ran without a human prompt. */
  silent: boolean;
  /** It caught a real danger and must STOP (data-safety guardrail). */
  stopped: boolean;
  /** Why it stopped (only when stopped). */
  reason?: string;
  /** What it did — recorded to the log, never surfaced as a prompt. */
  log: string;
}

/** Real-credential shapes (the same family used by event-log / validator-suite redaction).
 *  Matches actual keys, not the obvious fake fixtures used in tests/redaction. */
const REAL_SECRET =
  /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,})/;
/** Obvious non-secrets that must NOT trip the scan (redaction placeholders / fixtures). */
const FAKE_MARKERS = /FAKE|DO-NOT-USE|REDACTED|EXAMPLE|PLACEHOLDER|XXXX/i;

export interface SecretScan { found: boolean; sample?: string }

/** Scan text for a real credential about to be pushed. Fake/redacted markers are ignored. */
export function scanForRealSecret(text: string): SecretScan {
  const m = text.match(REAL_SECRET);
  if (!m) return { found: false };
  if (FAKE_MARKERS.test(m[0])) return { found: false }; // an obvious fixture, not a real key
  // report only a short masked sample, never the full value
  return { found: true, sample: `${m[0].slice(0, 6)}…(${m[0].length} chars)` };
}

/** Injected side-effecting runners (real git in production, fakes in tests). */
export interface BackstopRunners {
  /** Create the pre-force-push backup (e.g. a bundle). Returns a short locator for the log. */
  backup?: () => string;
  /** Run the pre-sync fresh-clone verify. Returns ok + the diff/output to be secret-scanned. */
  verify?: () => { ok: boolean; output?: string };
  /** Create the pre-promotion checkpoint. Returns a short locator for the log. */
  checkpoint?: () => string;
}

/**
 * Run a protective backstop. It ALWAYS executes its runner (silent ≠ removed) and
 * continues — EXCEPT `pre_sync_verify`, which additionally secret-scans its output and
 * STOPS if a real key is about to be pushed (data-safety guardrail), or if verify failed.
 */
export function runProtectiveBackstop(kind: BackstopKind, runners: BackstopRunners): BackstopResult {
  switch (kind) {
    case 'force_push_backup': {
      const loc = runners.backup ? runners.backup() : '(no backup runner)';
      return { kind, ran: Boolean(runners.backup), silent: true, stopped: false, log: `auto-backup created: ${loc}` };
    }
    case 'pre_promotion_checkpoint': {
      const loc = runners.checkpoint ? runners.checkpoint() : '(no checkpoint runner)';
      return { kind, ran: Boolean(runners.checkpoint), silent: true, stopped: false, log: `auto-checkpoint: ${loc}` };
    }
    case 'pre_sync_verify': {
      const res = runners.verify ? runners.verify() : { ok: true, output: '' };
      const ran = Boolean(runners.verify);
      if (!res.ok) {
        return { kind, ran, silent: true, stopped: true, reason: 'pre-sync verify failed', log: 'auto-verify ran; verification FAILED → stop' };
      }
      const scan = scanForRealSecret(res.output ?? '');
      if (scan.found) {
        // The backstop CAUGHT a real danger → stop. Data-safety guardrail, not a prompt.
        return { kind, ran, silent: true, stopped: true, reason: `real secret about to be pushed: ${scan.sample}`, log: `auto-verify ran; secret scan HIT (${scan.sample}) → stop` };
      }
      return { kind, ran, silent: true, stopped: false, log: 'auto-verify ran; secret scan clean → continue' };
    }
  }
}

/**
 * One-time ToS warning for the OPTIONAL subscription path (EPIC-035 / STORY-035.6, ADR-020 §6.1).
 * Printed once when the subscription plugin is enabled, so an operator can never quietly ship a
 * ToS-grey integration. The endorsed product default is a metered API key.
 */
export const SUBSCRIPTION_TOS_WARNING = [
  '⚠️  GateLoop subscription backend (Codex/ChatGPT) — UNOFFICIAL, ToS-GREY (ADR-020 §6.1):',
  '   • reuses a Codex OAuth client_id + an undocumented endpoint; OpenAI may change or BLOCK it.',
  '   • bring-your-own-credential: you supply and own the risk (one-time host login; not for cages).',
  '   • the ENDORSED, distributable default is a metered API key (OpenAI/Anthropic standard keys).',
  '   • Claude/Anthropic subscription is NOT available (Agent-SDK ToS forbids it).',
].join('\n');

let warned = false;

/** Print the ToS warning once per process. Returns true if it printed this call. */
export function warnSubscriptionToS(sink: (s: string) => void = (s) => console.warn(s)): boolean {
  if (warned) return false;
  warned = true;
  sink(SUBSCRIPTION_TOS_WARNING);
  return true;
}

/** Test hook — reset the once-guard. */
export function resetSubscriptionToSWarning(): void {
  warned = false;
}

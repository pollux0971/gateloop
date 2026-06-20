/**
 * A scripted/fixture engine (EPIC-035 / STORY-035.2) — drives the ProviderDriver with a fixed
 * sequence of neutral parts, NO real provider, NO network, NO spend. Implements the SAME
 * `LanguageModelEngine` interface as the AI-SDK engine, so the driver code under test is
 * identical to the gated path; only the engine is swapped. This is how 035.2/035.3/035.4 stay
 * zero-cost and CI-safe.
 */
import type { EngineStreamPart, EngineRunInput, LanguageModelEngine } from './engine';

export interface ScriptedEngineOptions {
  backendId?: string;
  model?: string;
  /** Parts to yield, or a function of the run input (to assert prompt/tools were received). */
  parts: EngineStreamPart[] | ((input: EngineRunInput) => EngineStreamPart[]);
  /** Records each run input for assertions (the driver passed the prompt/tools/signal). */
  onRun?: (input: EngineRunInput) => void;
}

export function createScriptedEngine(opts: ScriptedEngineOptions): LanguageModelEngine {
  return {
    backendId: opts.backendId ?? 'scripted',
    model: opts.model ?? 'scripted-model',
    async *stream(input: EngineRunInput): AsyncIterable<EngineStreamPart> {
      opts.onRun?.(input);
      const parts = typeof opts.parts === 'function' ? opts.parts(input) : opts.parts;
      for (const p of parts) yield p;
    },
  };
}

/** Convenience: a minimal successful one-tool run (tool-call → tool-result → finish). */
export function scriptedToolRun(toolName: string, input: unknown, output: unknown): EngineStreamPart[] {
  return [
    { type: 'reasoning-delta', text: `planning ${toolName}` },
    { type: 'tool-call', toolCallId: 't1', toolName, input },
    { type: 'tool-result', toolCallId: 't1', toolName, output },
    { type: 'text-delta', text: 'done' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
  ];
}

/**
 * The Vercel AI SDK boundary — ISOLATED here (EPIC-035 / STORY-035.2).
 *
 * This is the ONLY place an AI-SDK-shaped value lives, and even here the SDK is INJECTED, not
 * imported: there is no top-level `import ... from 'ai'` anywhere in the repo. The gated
 * wiring point (035.5) passes the real `streamText` (from `ai`) plus a model instance built
 * from a broker-resolved key (e.g. `createOpenAI({ apiKey })(modelId)`); this package never
 * holds the key and never reaches the network in scripted runs. Because `streamText` is a
 * parameter, the AI SDK is swappable and uninstalled for CI — the seam holds.
 */
import type { EngineStreamPart, EngineRunInput, EngineUsage, LanguageModelEngine } from './engine';

/** A minimal mirror of the AI SDK `streamText` fullStream part (we never import the SDK's type). */
export interface AiSdkStreamPart {
  type: string;
  text?: string;
  textDelta?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  args?: unknown;
  output?: unknown;
  result?: unknown;
  finishReason?: string;
  totalUsage?: { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
  usage?: { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
  error?: unknown;
}

export interface AiSdkStreamResult {
  fullStream: AsyncIterable<AiSdkStreamPart>;
}

/** The shape of the AI SDK's `streamText`, injected at the gated wiring point. */
export type AiSdkStreamText = (opts: {
  model: unknown;
  prompt?: string;
  system?: string;
  tools?: unknown;
  abortSignal?: AbortSignal;
}) => AiSdkStreamResult;

export interface AiSdkEngineDeps {
  backendId: string;
  model: string;
  /** AI SDK `streamText` — injected (never imported in this package). */
  streamText: AiSdkStreamText;
  /** AI SDK model instance built at the boundary from a broker-resolved key. */
  modelInstance: unknown;
}

function usageOf(p: AiSdkStreamPart): EngineUsage {
  const u = p.totalUsage ?? p.usage ?? {};
  return {
    inputTokens: u.inputTokens ?? u.promptTokens ?? 0,
    outputTokens: u.outputTokens ?? u.completionTokens ?? 0,
  };
}

/** Normalize one AI-SDK fullStream part to our neutral part (handles v4 `textDelta`/`args`
 *  and v5 `text`/`input` naming). Unknown part types collapse to nothing observable. */
export function normalizeAiSdkPart(p: AiSdkStreamPart): EngineStreamPart | null {
  switch (p.type) {
    case 'text-delta':
      return { type: 'text-delta', text: p.text ?? p.textDelta ?? '' };
    case 'reasoning':
    case 'reasoning-delta':
      return { type: 'reasoning-delta', text: p.text ?? p.textDelta ?? '' };
    case 'tool-call':
      return { type: 'tool-call', toolCallId: p.toolCallId ?? '', toolName: p.toolName ?? '', input: p.input ?? p.args ?? {} };
    case 'tool-result':
      return { type: 'tool-result', toolCallId: p.toolCallId ?? '', toolName: p.toolName ?? '', output: p.output ?? p.result ?? {} };
    case 'finish':
      return { type: 'finish', finishReason: p.finishReason ?? 'stop', usage: usageOf(p) };
    case 'error':
      return { type: 'error', error: p.error };
    default:
      return null;
  }
}

/** Build a LanguageModelEngine backed by the (injected) AI SDK. Real provider call happens
 *  ONLY when a real `streamText` + key-bearing `modelInstance` are supplied (035.5, gated). */
export function createAiSdkEngine(deps: AiSdkEngineDeps): LanguageModelEngine {
  return {
    backendId: deps.backendId,
    model: deps.model,
    async *stream(input: EngineRunInput): AsyncIterable<EngineStreamPart> {
      const res = deps.streamText({
        model: deps.modelInstance,
        prompt: input.prompt,
        system: input.system,
        abortSignal: input.signal,
      });
      for await (const raw of res.fullStream) {
        const part = normalizeAiSdkPart(raw);
        if (part) yield part;
      }
    },
  };
}

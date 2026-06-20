/**
 * @gateloop/provider-driver — the engine seam (EPIC-035 / STORY-035.2).
 *
 * This file is the ISOLATION MEMBRANE between the harness and the Vercel AI SDK. The core
 * (exit gate, guardrails, router, Observe) only ever sees `LanguageModelEngine` and the
 * neutral `EngineStreamPart` union — it NEVER imports `ai` / `@ai-sdk/*`. The real AI-SDK
 * engine (aiSdkEngine.ts) maps the SDK's stream parts onto these neutral parts, so the SDK
 * stays a swappable implementation detail and cannot recapture the core (the whole reason
 * ADR-020 left a single-vendor SDK). Scripted/fixture engines (scriptedEngine.ts) implement
 * the SAME interface, so tests drive the driver with zero real provider spend.
 */

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * A neutral streamed part — the shape every backend is normalized into. Deliberately
 * mirrors the Vercel AI SDK `streamText` fullStream parts (text/reasoning deltas, tool
 * call/result, finish, error) so the AI-SDK adapter is a thin, lossless map — but it is OUR
 * type, not the SDK's, so nothing AI-SDK-shaped crosses the seam.
 */
export type EngineStreamPart =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'finish'; finishReason: string; usage: EngineUsage }
  | { type: 'error'; error: unknown };

export interface EngineTool {
  name: string;
  description?: string;
}

export interface EngineRunInput {
  prompt: string;
  system?: string;
  /** Tool surface offered to the model (035.3 supplies the MCP-only, Bash-denied set). */
  tools?: EngineTool[];
  /** Wall-clock / budget kill from the entry gate, forwarded to the backend. */
  signal?: AbortSignal;
}

/**
 * The only thing the driver knows about a backend. An implementation drives a model
 * IN-PROCESS and yields neutral parts. `backendId` is the concrete backend (e.g. 'openai',
 * 'anthropic'); `model` is the resolved model id (the router picks it).
 */
export interface LanguageModelEngine {
  readonly backendId: string;
  readonly model: string;
  stream(input: EngineRunInput): AsyncIterable<EngineStreamPart>;
}

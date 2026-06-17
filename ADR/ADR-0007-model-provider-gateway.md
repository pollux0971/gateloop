# ADR-0007 — Model provider gateway with config-driven routing

## Status
Accepted

## Context
Agents must be runnable on different LLM backends (Anthropic, OpenAI/Codex,
DeepSeek, third-party OpenAI-compatible). Hardcoding a model couples the harness
to one vendor and prevents cost-aware routing.

## Decision
Introduce a deterministic Model Provider Gateway. Backends are declared in
`configs/providers.yaml`; per-agent/per-task routing and fallbacks in
`configs/model_routing.yaml`. Provider keys are resolved through Secret Broker
handles and never enter agent context. The gateway runs LLM backends only; it
does not authorize agent tool-API calls. Enabling a new provider for the first
time is a human gate.

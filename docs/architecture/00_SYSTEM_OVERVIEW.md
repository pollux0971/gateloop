# System Overview

GateLoop is an opencode-like coding platform with a harness-first control plane.

```text
Vite Web Cockpit
  -> API Server
  -> Harness Orchestrator
  -> Permission Gateway
  -> Tool Executor
  -> Workspace Manager / Container Runtime
  -> Trace Store / Artifact Store
```

## Agent layer

```text
Planning Steward -> Supervisor -> Developer -> Debugger
```

The agents produce structured outputs. The harness enforces policies, executes tools, writes traces, and validates artifacts.

## Design principle

The harness is deterministic by default. LLM agents provide planning and proposals, but the harness decides whether a tool call, transition, or promotion is allowed.

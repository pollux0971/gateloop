# Agent Topology

```text
Planning Steward -> Supervisor -> Developer -> Debugger
```

## Communication rule

Agents do not freely share all context. The Context Manager builds role-specific context packets.

## Agent authority

- Planning Steward: planning documents only.
- Supervisor: story contract and progress governance.
- Developer: patch proposal and implementation plan.
- Debugger: failure analysis and minimal repair proposal.

The harness controls tool execution.

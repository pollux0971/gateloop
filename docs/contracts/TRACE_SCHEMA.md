# Trace Schema

Trace is append-only. It is the basis for audit, rollback, debugging, and future improvement.

## Event families

- idea_event
- planning_event
- context_packet_event
- agent_output_event
- tool_request_event
- permission_decision_event
- execution_event
- validation_event
- approval_event
- promotion_event
- rollback_event

Trace files should be JSONL so they can be streamed and inspected.

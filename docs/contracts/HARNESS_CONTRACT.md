# Harness Contract

A Harness Contract is the implementation boundary for a story.

## Required fields

- contract_id
- story_id
- objective
- mode: greenfield | brownfield | patch | checkpoint | research_spike
- allowed_write_set
- forbidden_paths
- allowed_tools
- required_context_packets
- validation_commands
- rollback_plan_required
- promotion_allowed
- human_gate_required_for

## Contract rule

Developer and Debugger agents may not exceed the contract.

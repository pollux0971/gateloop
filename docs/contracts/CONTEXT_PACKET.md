# Context Packet

A Context Packet is the role-specific context given to an agent.

## Goals

- reduce irrelevant context
- prevent context drift
- prevent raw secret exposure
- preserve role boundaries

## Packet types

- planning_steward_packet
- supervisor_packet
- developer_packet
- debugger_packet

## Required metadata

- packet_id
- role
- story_id
- token_budget
- included_artifacts
- excluded_artifacts
- redaction_status
- provenance

# Document Handling Policy

## Mode-switching rules

| Mode | Context sections loaded |
|---|---|
| greenfield | templates (structure guides) + project profile |
| brownfield | project profile + as-is recovery docs + impact set |
| patch | same as brownfield + narrow impact set for the changed files |

## Separation invariants

- **as-is/** docs: read-only; never overwritten by generated output; always injected with priority 1.
- **to-be/** docs: generated; injected with priority 3 (evictable under token budget).
- Generated docs must never overwrite files outside the story's `allowed_write_set`.

## Enforcement

`buildModeAwarePacket` enforces section separation.
`assertDocWriteSafe` enforces write-set compliance before any doc write.

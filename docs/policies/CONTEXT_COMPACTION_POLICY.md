# Context Compaction Policy

## Rule

Compaction may replace active context, but never raw trace artifacts.

## Preserve raw

- events.jsonl
- tool requests
- tool outputs
- failed logs
- patch proposals
- approval records
- promotion records

## Compact active

- long conversation summaries
- repeated planning details
- resolved debug attempts

## Redact then preserve

- logs containing potential secrets
- provider error messages
- environment dumps

Every compact summary must link to the raw artifact it summarizes.

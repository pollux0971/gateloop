# Rollback Policy

Every story must declare rollback requirements.

## Rollback levels

1. Workspace rollback: delete disposable workspace.
2. Patch rollback: reverse patch.
3. Commit rollback: revert commit.
4. Promotion rollback: restore previous promoted checkpoint.

## Required rollback notes

- changed files
- generated artifacts
- workspace IDs
- database changes
- validation command after rollback

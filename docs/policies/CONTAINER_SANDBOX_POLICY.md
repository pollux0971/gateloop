# Container Sandbox

## Default profile

- rootless
- network disabled
- read-only root filesystem
- drop all capabilities
- no new privileges
- no host Docker socket
- CPU/memory/time limits
- stable repo read-only
- disposable workspace writable

## Bypass workspace mode

`bypass_workspace` is not equivalent to host-level dangerously-skip-permissions. It only means fewer prompts inside a disposable sandbox.

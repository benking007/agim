---
name: exec-sandbox
description: Linux bubblewrap (bwrap) isolation for agim_exec / writes. Use when enabling AGIM_EXEC_SANDBOX, diagnosing sandbox refusals, or choosing docker vs bwrap.
always: false
---

# Exec sandbox (`bwrap`)

Agim confines high-risk shell and (by default) writes when bubblewrap is installed.

## Defaults

| Knob | Behavior |
|---|---|
| `AGIM_EXEC_SANDBOX` unset + `/usr/bin/bwrap` present | sandbox **on** for `agim_exec` |
| `AGIM_EXEC_SANDBOX=off` | unconfined exec (operator choice) |
| `AGIM_NATIVE_FS_RESTRICT` unset | **writes follow** exec sandbox |
| `AGIM_NATIVE_FS_RESTRICT=1` | confine reads + writes to workspace |
| `AGIM_NATIVE_FS_RESTRICT=0` | allow host writes even if exec is sandboxed (loud warning) |

## Install (Debian/Ubuntu)

```bash
sudo apt-get update && sudo apt-get install -y bubblewrap
bwrap --version
```

Prefer bwrap over Docker on single-host, disk-tight machines. Use Docker when you need a reproducible image rollback point.

## Smoke test

```bash
bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin --tmpfs /tmp --chdir /tmp -- /bin/echo bwrap-ok
```

Then from Agim: `agim_exec` with a harmless command should succeed; writing outside the workspace should fail while sandbox follows writes.

## Docker alternative (optional)

```bash
sudo apt-get install -y docker.io
# run tooling inside a throwaway container; do not disable bwrap solely because docker exists
```

## Safety

- Do not set `AGIM_EXEC_SANDBOX=off` for routine coding unless the operator asks.
- Sensitive paths (`~/.agim`, `/etc/shadow`, …) stay denied regardless of sandbox.

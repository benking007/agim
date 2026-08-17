---
name: systemd-ops
description: Operate systemd-backed Agim-adjacent services (fin-data, system-dashboard, agent-cron, etc.). Status, journal logs, restart discipline with /health checks, hung-process handling, and config rollback.
always: false
metadata:
  agim:
    requires:
      bins: [systemctl, journalctl]
---

# systemd ops

Use this skill when restarting, diagnosing, or rolling back a unit on a host that runs services under systemd.

## Status

```bash
systemctl status <svc>
systemctl show <svc> -p ActiveState -p SubState -p ActiveEnterTimestamp -p MainPID
systemctl is-active <svc>
```

Common unit names on the fin-data host: `fin-data`, `system-dashboard`, `agent-cron` (confirm with `systemctl list-units --type=service | rg -i 'fin|agim|dashboard|cron'`).

## Logs

```bash
journalctl -u <svc> -n 100 --no-pager
journalctl -u <svc> -n 200 --no-pager | rg -i 'traceback|error|exception|fatal'
journalctl -u <svc> --since '10 min ago' --no-pager
```

Quote only the failing slice (last Traceback / error block), not the entire journal.

## Restart discipline

1. Probe health **before** restart: `curl -fsS http://127.0.0.1:<port>/health` (or the service’s documented health URL).
2. `sudo systemctl restart <svc>`
3. `sleep 8` (or the service’s known warm-up)
4. Re-probe `/health` and `systemctl is-active <svc>`
5. If unhealthy: pull journal (`-n 100`), do **not** loop restart without a diagnosis.

After editing a unit file or drop-in:

```bash
sudo systemctl daemon-reload
sudo systemctl restart <svc>
```

## Hung / zombie processes

```bash
systemctl show <svc> -p MainPID
ps -p <pid> -o pid,etime,cmd
```

1. Confirm the PID is the stuck worker.
2. `kill -TERM <pid>` → wait and confirm exit (`ps -p <pid>` empty).
3. Only then `kill -KILL <pid>` if still alive.
4. Prefer `systemctl restart <svc>` after cleanup so the supervisor owns the new MainPID.

Never `pkill -f` broad patterns on shared hosts.

## Backup before config/code changes

```bash
cp /etc/systemd/system/<svc>.service /etc/systemd/system/<svc>.service.bak.$(date +%Y%m%d%H%M%S)
# or for app config:
cp /path/to/config.json /path/to/config.json.bak.$(date +%Y%m%d%H%M%S)
```

Rollback = restore the `.bak.*` copy → `daemon-reload` if unit changed → restart → `/health`.

## Safety

- Prefer read-only diagnosis before mutation.
- Do not disable units (`systemctl disable`) unless the operator explicitly asks.
- Do not mask units.
- Keep secrets out of chat logs; redact tokens from journal snippets.

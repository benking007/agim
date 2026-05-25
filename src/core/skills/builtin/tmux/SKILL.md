---
name: tmux
description: Remote-control tmux sessions when you need an interactive TTY (REPLs, ncurses tools, ssh sessions with prompts). For long-running NON-interactive work prefer bgjob (`/root/.claude/scripts/bgjob`). Use only when the workflow genuinely needs keystrokes + screen scraping.
always: false
metadata:
  agim:
    os: [linux, darwin]
    requires:
      bins: [tmux]
---

# tmux

Use tmux **only** when you need an interactive TTY:

- Python / Node REPL with state across calls
- ncurses (htop, mc, vim) where output requires a terminal emulator
- ssh sessions that prompt for input
- Long-running CLIs whose output you'll scrape progressively

For everything else — long compiles, deploys, log tails — prefer agim's bgjob (`/root/.claude/scripts/bgjob start <name> -- <cmd>`). bgjob handles cgroup escape, has `tail`/`status`, persists across restarts.

## Quickstart (isolated socket)

Use a custom socket so tmux state stays scoped to this session and doesn't collide with the operator's own tmux:

```bash
SOCKET_DIR="${AGIM_TMUX_SOCKET_DIR:-/tmp/agim-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/agim.sock"
SESSION="agim-$(date +%s)"

tmux -S "$SOCKET" new -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter
sleep 0.3
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200
```

After spawning, **always print monitor commands** so the user can peek:

```
要观察会话：
  tmux -S "$SOCKET" attach -t "$SESSION"
  tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200
```

## Common patterns

Send a command + wait for prompt:
```bash
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'curl -sS https://example.com' Enter
sleep 1
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -100
```

Drain output until a known sentinel appears (poll, max 30s):
```bash
for i in $(seq 1 30); do
  if tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -50 | grep -q "READY"; then
    break
  fi
  sleep 1
done
```

Send Ctrl-C / Ctrl-D:
```bash
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 C-c
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 C-d
```

Kill the session when done:
```bash
tmux -S "$SOCKET" kill-session -t "$SESSION"
```

## Hygiene

- One session per task; name with a timestamp so multiple agents don't collide.
- Kill sessions when work is finished — orphan sessions sit there forever.
- Don't run long compute under tmux. The session will outlive your agim turn and you can't reattach next turn from a different process.
- Don't paste secrets into a tmux session — they end up in scrollback.

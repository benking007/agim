#!/usr/bin/env bash
# coding-env-host-bootstrap.sh — host-side P0/P1 tools for Agim coding env.
# Safe to re-run. Does NOT rewrite git user.name/email if already set
# (Cloud Agents keep their signed identity).
set -euo pipefail

log() { printf '[coding-env] %s\n' "$*"; }

ensure_path() {
  mkdir -p "$HOME/.local/bin"
  case ":$PATH:" in
    *:"$HOME/.local/bin":*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
  esac
  if [[ -f "$HOME/.bashrc" ]] && ! grep -qF '.local/bin' "$HOME/.bashrc"; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
  fi
}

install_uv_ruff() {
  ensure_path
  if ! command -v uv >/dev/null 2>&1; then
    log "installing uv…"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    ensure_path
  fi
  log "uv: $(uv --version)"
  if ! command -v ruff >/dev/null 2>&1; then
    log "installing ruff via uv tool…"
    uv tool install ruff
  fi
  log "ruff: $(ruff --version)"
}

install_bwrap() {
  if [[ -x /usr/bin/bwrap ]]; then
    log "bwrap: $(bwrap --version | head -1)"
    return
  fi
  if command -v apt-get >/dev/null 2>&1; then
    log "installing bubblewrap…"
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap
    log "bwrap: $(bwrap --version | head -1)"
  else
    log "skip bwrap — no apt-get (install bubblewrap manually)"
  fi
}

install_playwright_browser() {
  log "ensuring Playwright Chromium…"
  local cache="${HOME}/.cache/ms-playwright"
  if [[ -d "$cache" ]] && compgen -G "${cache}/chromium-*" > /dev/null; then
    log "Playwright Chromium cache present"
    return
  fi
  npx --yes playwright install chromium
}

wire_playwright_mcp() {
  local cfg="${AGIM_HOME:-$HOME/.agim}/config.json"
  mkdir -p "$(dirname "$cfg")"
  if [[ ! -f "$cfg" ]]; then
    log "no $cfg — write a minimal stub first (agim start / setup)"
    return
  fi
  python3 - "$cfg" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
cfg = json.loads(p.read_text())
servers = cfg.get("mcpServers") or []
if any(s.get("name") == "playwright" for s in servers):
    print("[coding-env] playwright MCP already configured")
else:
    servers.append({
        "name": "playwright",
        "command": "npx",
        "args": ["-y", "@playwright/mcp@latest"],
        "enabled": True,
    })
    cfg["mcpServers"] = servers
    p.write_text(json.dumps(cfg, indent=2) + "\n")
    print("[coding-env] added mcpServers.playwright — restart agim to load")
PY
}

git_identity_hint() {
  local name email
  name=$(git config --global user.name 2>/dev/null || true)
  email=$(git config --global user.email 2>/dev/null || true)
  if [[ -n "$name" && -n "$email" ]]; then
    log "git identity already set: $name <$email> (left unchanged)"
  else
    log "git identity empty — for a local Agim host you may set:"
    log '  git config --global user.name "Agim Agent"'
    log '  git config --global user.email "agim@local"'
  fi
}

smoke() {
  ensure_path
  ruff --version >/dev/null
  uv --version >/dev/null
  if [[ -x /usr/bin/bwrap ]]; then
    local binds=(--ro-bind /usr /usr --ro-bind /bin /bin --tmpfs /tmp --chdir /tmp)
    [[ -d /lib ]] && binds+=(--ro-bind /lib /lib)
    [[ -d /lib64 ]] && binds+=(--ro-bind /lib64 /lib64)
    bwrap "${binds[@]}" -- /bin/echo ok >/dev/null
  fi
  log "smoke OK"
}

main() {
  git_identity_hint
  install_uv_ruff
  install_bwrap
  install_playwright_browser
  wire_playwright_mcp
  smoke
  log "done. Next: restart agim, then run: agim setup mcp health playwright"
}

main "$@"

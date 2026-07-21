"""agim_rpc — tiny Python client for the agim local RPC bridge.

Spawned by `native_exec` via the bgjob wrapper, this module gives a
detached Python worker a typed entry point into the same agim MCP
tools the in-process native agent uses (memo / skill / push). One
worker can do dozens of tool calls without any LLM round-trip.

Usage from a bgjob-launched Python script::

    from agim_rpc import client
    rpc = client()                                  # reads env, validates token
    hits = rpc.search_memos(query="茅台", k=5)       # tool name → method name
    for h in hits.get("rows", []):
        ...
    rpc.push_message(text="后台跑完了，找到 %d 条" % len(hits.get("rows", [])))

Design notes:
  * Zero external deps — stdlib only (urllib + json + socket).
  * Communicates with the agim parent process over a Unix-domain socket.
    Path comes from env AGIM_RPC_SOCKET (agim sets this when spawning
    the child); token from AGIM_RPC_TOKEN.
  * Each RPC call is a single HTTP POST. Failures raise RpcError with
    the error string so the worker can decide whether to abort.
  * Whitelist matches the server: search_memos / save_memo / read_skill /
    list_skills / push_message. Anything else returns 403.

Forward compat: when agim ships new tools to the whitelist, this
module gets a corresponding method. Operators on older Python clients
can still call them via the lower-level `rpc.call(tool_name, args)`.
"""
import http.client
import json
import os
import socket
import ssl as _ssl  # noqa: F401  — placeholder, not used
from typing import Any, Dict, Optional


class RpcError(Exception):
    """Raised when the RPC server returns ok=False or a non-2xx status."""

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


class _UnixHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection variant that talks over a Unix-domain socket
    instead of TCP. Host header is set to 'localhost' for protocol
    compliance; the actual transport is the socket path."""

    def __init__(self, socket_path: str, timeout: float = 30.0) -> None:
        super().__init__("localhost", timeout=timeout)
        self._socket_path = socket_path

    def connect(self) -> None:  # type: ignore[override]
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._socket_path)
        self.sock = sock


class AgimRpcClient:
    """Typed wrapper around the agim RPC surface. Construct via the
    module-level `client()` helper — that reads env + validates."""

    def __init__(self, socket_path: str, token: str, timeout: float = 30.0) -> None:
        self.socket_path = socket_path
        self.token = token
        self.timeout = timeout

    def call(self, tool: str, args: Optional[Dict[str, Any]] = None) -> Any:
        """Low-level dispatch. Returns the `result` field on success;
        raises RpcError on failure. Most callers should use the typed
        methods below — they call into this with the right tool name."""
        body = json.dumps({"args": args or {}}).encode("utf-8")
        conn = _UnixHTTPConnection(self.socket_path, timeout=self.timeout)
        try:
            conn.request(
                "POST",
                f"/rpc/{tool}",
                body=body,
                headers={
                    "X-Agim-Rpc-Token": self.token,
                    "Content-Type": "application/json",
                },
            )
            resp = conn.getresponse()
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.status
        finally:
            conn.close()

        try:
            payload = json.loads(raw)
        except Exception as e:
            raise RpcError(f"non-JSON response (status={status}): {raw[:200]}", status=status) from e

        if not isinstance(payload, dict):
            raise RpcError(f"unexpected payload (status={status}): {raw[:200]}", status=status)
        if not payload.get("ok", False):
            raise RpcError(payload.get("error", f"unknown error (status={status})"), status=status)
        return payload.get("result")

    # ─── typed methods (the v1.2.97 whitelist) ──────────────────────

    def search_memos(self, query: str = "", **kwargs: Any) -> Any:
        return self.call("mcp__agim__search_memos", {"query": query, **kwargs})

    def save_memo(self, what: str, **kwargs: Any) -> Any:
        return self.call("mcp__agim__save_memo", {"what": what, **kwargs})

    def read_skill(self, name: str) -> Any:
        return self.call("mcp__agim__read_skill", {"name": name})

    def list_skills(self) -> Any:
        return self.call("mcp__agim__list_skills", {})

    def push_message(self, text: str, **kwargs: Any) -> Any:
        return self.call("mcp__agim__push_message", {"text": text, **kwargs})


def client(timeout: float = 30.0) -> AgimRpcClient:
    """Construct a client from the env vars agim's exec-dispatcher
    sets before spawning the bgjob worker. Raises RuntimeError if the
    parent process didn't pass them in — that means we're not running
    inside an agim-managed bgjob."""
    socket_path = os.environ.get("AGIM_RPC_SOCKET")
    token = os.environ.get("AGIM_RPC_TOKEN")
    if not socket_path:
        raise RuntimeError(
            "AGIM_RPC_SOCKET not set — agim_rpc only works inside a "
            "bgjob spawned by agim's native_exec. Re-run via the bgjob "
            "wrapper, e.g. ~/.agim/scripts/bgjob start ..."
        )
    if not token:
        raise RuntimeError("AGIM_RPC_TOKEN not set — agim parent did not mint a token")
    if not os.path.exists(socket_path):
        raise RuntimeError(f"RPC socket {socket_path} missing — agim parent may not be running")
    return AgimRpcClient(socket_path, token, timeout=timeout)

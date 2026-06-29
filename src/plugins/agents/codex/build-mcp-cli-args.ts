// build-mcp-cli-args.ts — translate {sockPath, runId} into the `-c` CLI
// args that register the agim MCP server inline with `codex exec`.
//
// Why CLI args (not the global ~/.codex/config.toml):
//
//   The runId is per-spawn (one per IM thread, registered with approvalBus
//   for that spawn only). Writing it to the user's persistent config would
//   leak across spawns and pollute their hand-edited toml. codex's `-c key=
//   value` flag accepts inline TOML and merges over the persisted config
//   for THAT INVOCATION only — exactly what we need.
//
//   Verified against codex 0.130.0: `-c 'mcp_servers.agim.command="..."'`
//   + `-c 'mcp_servers.agim.args=["..."]'` + `-c 'mcp_servers.agim.env={
//   K="v"}'` causes codex to spawn the MCP child with that command and env.
//   The MCP child receives ONLY the env we list there (no parent-process
//   inheritance), which is fine because mcp-approval-server.ts reads just
//   AGIM_APPROVAL_SOCK and AGIM_RUN_ID, and we hand it the absolute node
//   binary path so it doesn't need PATH.
//
// TOML escaping: values are wrapped with JSON.stringify, which yields a
// quoted string matching TOML's basic-string grammar (backslash + double-
// quote both escape correctly in both formats). String arrays go through
// JSON.stringify too — TOML accepts the JSON-compatible `["a", "b"]` form.
// We do NOT cover edge cases like control chars or non-BMP code points
// because socket paths and UUIDs never contain them.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Path to the shared MCP sidecar. Same JS that claude-code uses — codex
 * just talks to it over a different transport (stdio either way; the
 * difference is who launches it). Kept in claude-code/ to avoid copying
 * 700 lines.
 */
export const CODEX_MCP_SIDECAR_PATH = join(
  __dirname, '..', 'claude-code', 'mcp-approval-server.js',
)

export interface CodexMcpEnvInput {
  sockPath: string
  runId: string
  /** Override sidecar path for tests. */
  sidecarPath?: string
  /** Override node binary for tests. Production uses process.execPath. */
  nodeBinary?: string
}

/**
 * Build the `-c` argument list that registers the agim MCP server inline
 * for one `codex exec` invocation. Returns a flat array suitable for
 * splicing into the codex argv (each `-c` and its key=value are separate
 * argv entries — codex's clap parser requires it).
 *
 * Example output (formatted):
 *   -c mcp_servers.agim.command="/usr/bin/node"
 *   -c mcp_servers.agim.args=["/path/to/mcp-approval-server.js"]
 *   -c mcp_servers.agim.env={AGIM_APPROVAL_SOCK="/tmp/foo.sock",AGIM_RUN_ID="abc-123"}
 */
export function buildCodexMcpCliArgs(input: CodexMcpEnvInput): string[] {
  const node = input.nodeBinary ?? process.execPath
  const sidecar = input.sidecarPath ?? CODEX_MCP_SIDECAR_PATH

  const commandVal = JSON.stringify(node)
  const argsVal = JSON.stringify([sidecar])
  const envVal = formatTomlInlineEnv({
    AGIM_APPROVAL_SOCK: input.sockPath,
    AGIM_RUN_ID: input.runId,
  })

  return [
    '-c', `mcp_servers.agim.command=${commandVal}`,
    '-c', `mcp_servers.agim.args=${argsVal}`,
    '-c', `mcp_servers.agim.env=${envVal}`,
  ]
}

/**
 * Render `{K="v", K2="v2"}` for codex's `-c` inline TOML. Keys are emitted
 * in insertion order. Values are JSON-stringified (TOML basic-string
 * grammar is a strict subset of JSON-string grammar for these inputs).
 *
 * No keys are quoted because we control the names — they're ASCII
 * bareword identifiers (AGIM_* and similar).
 */
function formatTomlInlineEnv(env: Record<string, string>): string {
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  return `{${pairs.join(',')}}`
}

// build-mcp-cli-args — pure-function unit tests. Verifies the -c arg
// shape codex needs, plus TOML escaping for awkward but realistic
// socket paths (spaces, backslashes) and run ids.

import { describe, it, expect } from 'bun:test'
import { buildCodexMcpCliArgs, CODEX_MCP_SIDECAR_PATH } from './build-mcp-cli-args.js'

describe('buildCodexMcpCliArgs — argv shape', () => {
  it('emits three -c pairs in the canonical order (command, args, env)', () => {
    const out = buildCodexMcpCliArgs({
      sockPath: '/tmp/x.sock',
      runId: 'abc-123',
      sidecarPath: '/sidecar.js',
      nodeBinary: '/usr/bin/node',
    })
    expect(out.length).toBe(6)
    expect(out[0]).toBe('-c')
    expect(out[1]).toBe('mcp_servers.agim.command="/usr/bin/node"')
    expect(out[2]).toBe('-c')
    expect(out[3]).toBe('mcp_servers.agim.args=["/sidecar.js"]')
    expect(out[4]).toBe('-c')
    expect(out[5]).toBe('mcp_servers.agim.env={AGIM_APPROVAL_SOCK="/tmp/x.sock",AGIM_RUN_ID="abc-123"}')
  })

  it('defaults nodeBinary to process.execPath', () => {
    const out = buildCodexMcpCliArgs({
      sockPath: '/s', runId: 'r', sidecarPath: '/x.js',
    })
    expect(out[1]).toBe(`mcp_servers.agim.command=${JSON.stringify(process.execPath)}`)
  })

  it('defaults sidecarPath to the resolved CODEX_MCP_SIDECAR_PATH', () => {
    const out = buildCodexMcpCliArgs({
      sockPath: '/s', runId: 'r', nodeBinary: '/n',
    })
    expect(out[3]).toBe(`mcp_servers.agim.args=${JSON.stringify([CODEX_MCP_SIDECAR_PATH])}`)
    expect(CODEX_MCP_SIDECAR_PATH).toMatch(/mcp-approval-server\.js$/)
  })
})

describe('buildCodexMcpCliArgs — TOML escaping', () => {
  // Codex parses each `-c key=value` payload as TOML. JSON.stringify gives
  // us a basic-string compatible quote/escape for the values we care about
  // (paths, UUIDs). These tests pin the contract so a future refactor doesn't
  // silently break codex's parser with raw concatenation.

  it('escapes embedded double quotes in sockPath', () => {
    const out = buildCodexMcpCliArgs({
      sockPath: '/tmp/we"ird.sock',
      runId: 'r',
      sidecarPath: '/x.js',
      nodeBinary: '/n',
    })
    expect(out[5]).toContain('AGIM_APPROVAL_SOCK="/tmp/we\\"ird.sock"')
  })

  it('escapes embedded backslash', () => {
    const out = buildCodexMcpCliArgs({
      sockPath: '/tmp/back\\slash.sock',
      runId: 'r',
      sidecarPath: '/x.js',
      nodeBinary: '/n',
    })
    expect(out[5]).toContain('AGIM_APPROVAL_SOCK="/tmp/back\\\\slash.sock"')
  })

  it('preserves runId verbatim (UUIDs and similar)', () => {
    const out = buildCodexMcpCliArgs({
      sockPath: '/s',
      runId: '019df376-0ec9-77c3-9d7d-1a15fd8cc9c9',
      sidecarPath: '/x.js',
      nodeBinary: '/n',
    })
    expect(out[5]).toContain('AGIM_RUN_ID="019df376-0ec9-77c3-9d7d-1a15fd8cc9c9"')
  })

  it('survives a spaced sidecarPath without breaking the array literal', () => {
    const out = buildCodexMcpCliArgs({
      sockPath: '/s', runId: 'r',
      sidecarPath: '/path with spaces/x.js',
      nodeBinary: '/n',
    })
    expect(out[3]).toBe('mcp_servers.agim.args=["/path with spaces/x.js"]')
  })
})

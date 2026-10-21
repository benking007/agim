import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgePeerError, bridgePeersFile, loadBridgePeers, saveBridgePeers, type BridgePeer } from './bridge-peers.js'

const savedHome = process.env.AGIM_HOME
const savedPrivate = process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS
let home = ''

function peer(overrides: Partial<BridgePeer> = {}): BridgePeer {
  return {
    peerId: 'dev-agim',
    tokenId: 'tk_peer',
    agents: ['agim'],
    workspaceId: 'default',
    callbackMode: 'poll',
    callbackUrl: null,
    signingSecret: null,
    enabled: true,
    maxConcurrent: 1,
    callbackPinnedHost: null,
    ...overrides,
  }
}

describe('bridge peer file', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agim-bridge-peers-'))
    process.env.AGIM_HOME = home
    delete process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.AGIM_HOME
    else process.env.AGIM_HOME = savedHome
    if (savedPrivate === undefined) delete process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS
    else process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS = savedPrivate
    rmSync(home, { recursive: true, force: true })
  })

  it('stores a poll-only peer at mode 0600 and reloads it', async () => {
    await saveBridgePeers([peer()])
    const mode = statSync(bridgePeersFile()).mode & 0o777
    expect(mode).toBe(0o600)
    expect(loadBridgePeers()).toEqual([peer()])
  })

  it('rejects an empty-allowlist peer only at request time, and rejects a private callback without a pin', async () => {
    await saveBridgePeers([peer({ agents: [] })])
    expect(loadBridgePeers()[0]?.agents).toEqual([])
    process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS = '1'
    await expect(saveBridgePeers([peer({
      callbackUrl: 'http://127.0.0.1/hook',
      signingSecret: 'not-logged',
    })])).rejects.toBeInstanceOf(BridgePeerError)
  })

  it('allows a private callback only when that hostname is pinned on the peer', async () => {
    process.env.AGIM_ALLOW_PRIVATE_WEBHOOKS = '1'
    await saveBridgePeers([peer({
      callbackUrl: 'http://10.1.2.3/hook',
      signingSecret: 'raw-secret',
      callbackPinnedHost: '10.1.2.3',
    })])
    const loaded = loadBridgePeers()[0]
    expect(loaded?.callbackUrl).toBe('http://10.1.2.3/hook')
    expect(loaded?.callbackPinnedHost).toBe('10.1.2.3')
    expect(loaded?.signingSecret).toBe('raw-secret')
  })
})

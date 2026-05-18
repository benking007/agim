// M-N10 — WebSocket inbound-frame size cap.
//
// The /ws handler JSON.parses every frame it receives. Without a cap a
// hostile or buggy client can dump a multi-MiB deeply-nested payload
// and burn CPU on parse alone; with IMHUB_MAX_WS_MSG_BYTES set the
// server closes the socket cleanly (RFC 6455 code 1009) before the
// frame reaches JSON.parse.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import WebSocket from 'ws'
import { startWebServer } from '../../src/web/server'
import { registry } from '../../src/core/registry'
import type { AgentAdapter, MessengerAdapter } from '../../src/core/types'

async function* yieldOnce(s: string): AsyncGenerator<string> { yield s }

const stubAgent: AgentAdapter = {
  name: 'ws-stub',
  aliases: ['stub'],
  isAvailable: async () => true,
  sendPrompt: () => yieldOnce('ok'),
}

const stubMessenger: MessengerAdapter = {
  name: 'ws-msg',
  start: async () => {},
  stop: async () => {},
  onMessage: () => {},
  sendMessage: async () => {},
}

let port = 0
let close: () => void

beforeAll(async () => {
  registry.registerAgent(stubAgent)
  registry.registerMessenger(stubMessenger)
  // Tight cap so the test doesn't have to allocate a real megabyte.
  process.env.IMHUB_MAX_WS_MSG_BYTES = '1024'
  port = 9000 + Math.floor(Math.random() * 1000)
  const server = await startWebServer({ port, defaultAgent: 'ws-stub' })
  close = server.close
})

afterAll(() => {
  close?.()
  delete process.env.IMHUB_MAX_WS_MSG_BYTES
})

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** Drain the welcome `init` frame the server sends on connect, then resolve. */
async function awaitWelcome(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no welcome')), 2000)
    ws.once('message', () => { clearTimeout(timer); resolve() })
  })
}

describe('WS inbound size cap (M-N10)', () => {
  it('closes with 1009 when frame exceeds IMHUB_MAX_WS_MSG_BYTES', async () => {
    const ws = await openSocket()
    await awaitWelcome(ws)

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })

    // 2 KiB > 1 KiB cap
    const payload = JSON.stringify({ type: 'message', text: 'x'.repeat(2048) })
    ws.send(payload)

    const ev = await closed
    expect(ev.code).toBe(1009)
    expect(ev.reason).toBe('Message too large')
  })

  it('accepts frames under the cap (regression guard)', async () => {
    const ws = await openSocket()
    await awaitWelcome(ws)

    // Send a tiny valid frame; server may reply or stay quiet, but it
    // must not close with 1009.
    const closeEv: Promise<number | null> = new Promise((resolve) => {
      let resolved = false
      ws.once('close', (code) => { if (!resolved) { resolved = true; resolve(code) } })
      setTimeout(() => { if (!resolved) { resolved = true; resolve(null) } }, 500)
    })

    ws.send(JSON.stringify({ type: 'message', text: 'hi' }))
    const code = await closeEv
    // Either no close within the window (null) or a non-1009 close.
    expect(code === null || code !== 1009).toBe(true)
    try { ws.close() } catch { /* already closed */ }
  })
})

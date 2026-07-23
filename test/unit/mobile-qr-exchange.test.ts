import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('mobile-qr-exchange', () => {
  let home: string
  const prev = process.env.AGIM_HOME

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agim-mqe-'))
    process.env.AGIM_HOME = home
  })

  afterEach(async () => {
    const mod = await import('../../src/core/mobile-qr-exchange.js')
    mod.__resetMobileQrExchangeForTesting()
    if (prev === undefined) delete process.env.AGIM_HOME
    else process.env.AGIM_HOME = prev
    try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('issues a code and consumes it once', async () => {
    const mod = await import('../../src/core/mobile-qr-exchange.js')
    mod.__resetMobileQrExchangeForTesting()
    const { code } = mod.issueMobileQrExchange('agim_deadbeef', 'tk_abc')
    expect(code.length).toBeGreaterThan(20)
    const first = mod.consumeMobileQrExchange(code)
    expect(first).toEqual({ raw: 'agim_deadbeef', tokenId: 'tk_abc' })
    expect(mod.consumeMobileQrExchange(code)).toBeNull()
  })

  it('rejects expired codes', async () => {
    const mod = await import('../../src/core/mobile-qr-exchange.js')
    mod.__resetMobileQrExchangeForTesting()
    const { code } = mod.issueMobileQrExchange('agim_y', 'tk_y')
    mod.__expireMobileQrExchangeForTesting(code)
    expect(mod.consumeMobileQrExchange(code)).toBeNull()
  })

  it('rejects unknown codes', async () => {
    const mod = await import('../../src/core/mobile-qr-exchange.js')
    mod.__resetMobileQrExchangeForTesting()
    expect(mod.consumeMobileQrExchange('nope')).toBeNull()
  })
})

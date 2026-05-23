import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const tmpHome = join('/tmp', `agim-web-bootstrap-test-${process.pid}`)

describe('web access-token bootstrap file', () => {
  let prevHome: string | undefined

  beforeEach(() => {
    prevHome = process.env.AGIM_HOME
    process.env.AGIM_HOME = tmpHome
    mkdirSync(tmpHome, { recursive: true })
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGIM_HOME
    else process.env.AGIM_HOME = prevHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('bootstrapIfEmpty writes web-bootstrap-token file', async () => {
    const {
      bootstrapIfEmpty,
      WEB_BOOTSTRAP_TOKEN_FILE,
      hasAnyToken,
    } = await import('../../src/core/access-token.js')

    const raw = bootstrapIfEmpty()
    expect(raw).toBeTruthy()
    expect(hasAnyToken()).toBe(true)
    expect(existsSync(WEB_BOOTSTRAP_TOKEN_FILE)).toBe(true)
  })

  it('retrieveWebBootstrapTokenRaw reads file once then deletes it', async () => {
    const {
      bootstrapIfEmpty,
      retrieveWebBootstrapTokenRaw,
      WEB_BOOTSTRAP_TOKEN_FILE,
    } = await import('../../src/core/access-token.js')

    const created = bootstrapIfEmpty()
    expect(created).toBeTruthy()

    const first = retrieveWebBootstrapTokenRaw()
    expect(first?.raw).toBe(created)
    expect(existsSync(WEB_BOOTSTRAP_TOKEN_FILE)).toBe(false)

    const second = retrieveWebBootstrapTokenRaw()
    expect(second).toBeNull()
  })

  it('retrieveWebBootstrapTokenRaw reads a pre-existing bootstrap file', async () => {
    const {
      retrieveWebBootstrapTokenRaw,
      WEB_BOOTSTRAP_TOKEN_FILE,
      createToken,
    } = await import('../../src/core/access-token.js')

    const t = createToken('bootstrap')
    writeFileSync(WEB_BOOTSTRAP_TOKEN_FILE, t.raw + '\n')

    const row = retrieveWebBootstrapTokenRaw()
    expect(row?.raw).toBe(t.raw)
    expect(existsSync(WEB_BOOTSTRAP_TOKEN_FILE)).toBe(false)
  })
})

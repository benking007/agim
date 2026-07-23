import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('web-thread-owners', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agim-thread-owners-'))
    savedHome = process.env.AGIM_HOME
    process.env.AGIM_HOME = home
  })

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.AGIM_HOME
    else process.env.AGIM_HOME = savedHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('persists claims across store reloads', async () => {
    const mod = await import(`./web-thread-owners.js?t=${Date.now()}`)
    mod.webThreadOwners._resetForTests()
    expect(mod.webThreadOwners.claim('web-abc12345', 'tok-a')).toBe(true)
    expect(mod.webThreadOwners.claim('web-abc12345', 'tok-b')).toBe(false)
    expect(mod.webThreadOwners.get('web-abc12345')).toBe('tok-a')

    const raw = await readFile(join(home, 'web-thread-owners.json'), 'utf-8')
    expect(raw).toContain('web-abc12345')
    expect(raw).toContain('tok-a')

    mod.webThreadOwners._resetForTests()
    expect(mod.webThreadOwners.get('web-abc12345')).toBe('tok-a')
    expect(mod.webThreadOwners.claim('web-abc12345', 'tok-b')).toBe(false)
  })

  it('rekey moves ownership', async () => {
    const mod = await import(`./web-thread-owners.js?t=${Date.now() + 1}`)
    mod.webThreadOwners._resetForTests()
    mod.webThreadOwners.set('web-oldidxxxx', 'tok-a')
    mod.webThreadOwners.rekey('web-oldidxxxx', 'web-newidxxxx')
    expect(mod.webThreadOwners.get('web-oldidxxxx')).toBeUndefined()
    expect(mod.webThreadOwners.get('web-newidxxxx')).toBe('tok-a')
  })
})

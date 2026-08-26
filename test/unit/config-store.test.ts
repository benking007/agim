import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfigLockTimeoutError,
  readConfigObject,
  updateConfigObject,
  writeConfigObject,
} from '../../src/core/config-store.js'

const DIR = mkdtempSync(join(tmpdir(), 'agim-config-store-'))
const FILE = join(DIR, 'config.json')
const STORE_MODULE = new URL('../../src/core/config-store.ts', import.meta.url).href
const CHILD_SCRIPT = join(DIR, 'child-update.mjs')

writeFileSync(CHILD_SCRIPT, [
  'const [modUrl, filePath, field, value, lockTimeoutMs] = process.argv.slice(2)',
  'const { updateConfigObject } = await import(modUrl)',
  'await updateConfigObject((current) => ({',
  '  config: { ...current, [field]: Number(value) },',
  '  result: undefined,',
  '}), { filePath, lockTimeoutMs: Number(lockTimeoutMs) })',
].join('\n'), 'utf-8')

function runChildUpdate(field: string, value: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CHILD_SCRIPT,
      STORE_MODULE,
      FILE,
      field,
      String(value),
      '20000',
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`config child ${field} exited ${code}: ${stderr}`))
    })
  })
}

beforeEach(() => {
  for (const name of readdirSync(DIR)) {
    if (name === 'child-update.mjs') continue
    rmSync(join(DIR, name), { recursive: true, force: true })
  }
})

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe('config-store', () => {
  it('atomically writes owner-only JSON without temporary files', async () => {
    await writeConfigObject({ agents: ['native'], defaultAgent: 'agim' }, { filePath: FILE })

    expect(await readConfigObject({ filePath: FILE })).toEqual({
      agents: ['native'],
      defaultAgent: 'agim',
    })
    expect(statSync(FILE).mode & 0o777).toBe(0o600)
    expect(readdirSync(DIR).filter((n) => n !== 'child-update.mjs')).toEqual(['config.json'])
  })

  it('strips retired ACP keys on write', async () => {
    await writeConfigObject({
      agents: ['agim'],
      defaultAgent: 'agim',
      acpPort: 9090,
      acpAgents: [{ name: 'x', endpoint: 'https://example.com' }],
      acpDiscoveryUrls: ['https://example.com'],
    }, { filePath: FILE })

    const stored = await readConfigObject({ filePath: FILE })
    expect(stored).toEqual({ agents: ['agim'], defaultAgent: 'agim' })
    expect(stored.acpPort).toBeUndefined()
    expect(stored.acpAgents).toBeUndefined()
    expect(stored.acpDiscoveryUrls).toBeUndefined()
  })

  it('serializes concurrent read-modify-write transactions', async () => {
    await writeConfigObject({ seed: true }, { filePath: FILE })

    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      updateConfigObject((current) => ({
        config: { ...current, [`field${i}`]: i },
        result: i,
      }), { filePath: FILE })))

    const stored = await readConfigObject({ filePath: FILE })
    expect(stored.seed).toBe(true)
    for (let i = 0; i < 20; i++) expect(stored[`field${i}`]).toBe(i)
    expect(readdirSync(DIR).filter((n) => n !== 'child-update.mjs')).toEqual(['config.json'])
  })

  it('serializes updates from independent processes', async () => {
    await writeConfigObject({ seed: true }, { filePath: FILE })

    // Two waves keep CI load lower while still stressing cross-process locking.
    const wave = async (offset: number, count: number) => {
      await Promise.all(Array.from({ length: count }, (_, i) => {
        const n = offset + i
        return runChildUpdate(`child${n}`, n)
      }))
    }
    await wave(0, 8)
    await wave(8, 8)

    const stored = await readConfigObject({ filePath: FILE })
    expect(stored.seed).toBe(true)
    for (let i = 0; i < 16; i++) expect(stored[`child${i}`]).toBe(i)
    expect(readdirSync(DIR).filter((n) => n !== 'child-update.mjs')).toEqual(['config.json'])
  }, { retry: 2, timeout: 20_000 })

  it('keeps the previous config when an updater throws', async () => {
    await writeConfigObject({ stable: 'yes' }, { filePath: FILE })

    await expect(updateConfigObject(() => {
      throw new Error('validation failed')
    }, { filePath: FILE })).rejects.toThrow('validation failed')

    expect(await readConfigObject({ filePath: FILE })).toEqual({ stable: 'yes' })
    expect(readdirSync(DIR).filter((n) => n !== 'child-update.mjs')).toEqual(['config.json'])
  })

  it('reclaims a lock whose owner process no longer exists', async () => {
    writeFileSync(`${FILE}.lock`, JSON.stringify({ pid: 999_999_999, token: 'dead' }))

    await writeConfigObject({ recovered: true }, { filePath: FILE })

    expect(await readConfigObject({ filePath: FILE })).toEqual({ recovered: true })
    expect(readdirSync(DIR).filter((n) => n !== 'child-update.mjs')).toEqual(['config.json'])
  })

  it('times out instead of stealing a live lock', async () => {
    writeFileSync(`${FILE}.lock`, JSON.stringify({ pid: process.pid, token: 'live' }))

    await expect(writeConfigObject({ unsafe: true }, {
      filePath: FILE,
      lockTimeoutMs: 20,
      staleLockMs: 60_000,
    })).rejects.toBeInstanceOf(ConfigLockTimeoutError)
    expect(readdirSync(DIR).filter((n) => n !== 'child-update.mjs')).toEqual(['config.json.lock'])
  })

  it('rejects malformed or non-object config content', async () => {
    writeFileSync(FILE, '[1,2,3]')
    await expect(readConfigObject({ filePath: FILE })).rejects.toThrow('must contain a JSON object')

    writeFileSync(FILE, '{broken')
    await expect(readConfigObject({ filePath: FILE })).rejects.toBeInstanceOf(SyntaxError)
  })
})

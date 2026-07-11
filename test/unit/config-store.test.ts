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

function runChildUpdate(field: string, value: number): Promise<void> {
  const source = [
    `const { updateConfigObject } = await import(${JSON.stringify(STORE_MODULE)})`,
    `await updateConfigObject((current) => ({`,
    `  config: { ...current, [${JSON.stringify(field)}]: ${value} },`,
    `  result: undefined,`,
    `}), { filePath: ${JSON.stringify(FILE)} })`,
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--eval', source], {
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
      else reject(new Error(`config child exited ${code}: ${stderr}`))
    })
  })
}

beforeEach(() => {
  for (const name of readdirSync(DIR)) rmSync(join(DIR, name), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe('config-store', () => {
  it('atomically writes owner-only JSON without temporary files', async () => {
    await writeConfigObject({ agents: ['native'], defaultAgent: 'native' }, { filePath: FILE })

    expect(await readConfigObject({ filePath: FILE })).toEqual({
      agents: ['native'],
      defaultAgent: 'native',
    })
    expect(statSync(FILE).mode & 0o777).toBe(0o600)
    expect(readdirSync(DIR)).toEqual(['config.json'])
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
    expect(readdirSync(DIR)).toEqual(['config.json'])
  })

  it('serializes updates from independent processes', async () => {
    await writeConfigObject({ seed: true }, { filePath: FILE })

    await Promise.all(Array.from({ length: 16 }, (_, i) => runChildUpdate(`child${i}`, i)))

    const stored = await readConfigObject({ filePath: FILE })
    expect(stored.seed).toBe(true)
    for (let i = 0; i < 16; i++) expect(stored[`child${i}`]).toBe(i)
    expect(readdirSync(DIR)).toEqual(['config.json'])
  })

  it('keeps the previous config when an updater throws', async () => {
    await writeConfigObject({ stable: 'yes' }, { filePath: FILE })

    await expect(updateConfigObject(() => {
      throw new Error('validation failed')
    }, { filePath: FILE })).rejects.toThrow('validation failed')

    expect(await readConfigObject({ filePath: FILE })).toEqual({ stable: 'yes' })
    expect(readdirSync(DIR)).toEqual(['config.json'])
  })

  it('reclaims a lock whose owner process no longer exists', async () => {
    writeFileSync(`${FILE}.lock`, JSON.stringify({ pid: 999_999_999, token: 'dead' }))

    await writeConfigObject({ recovered: true }, { filePath: FILE })

    expect(await readConfigObject({ filePath: FILE })).toEqual({ recovered: true })
    expect(readdirSync(DIR)).toEqual(['config.json'])
  })

  it('times out instead of stealing a live lock', async () => {
    writeFileSync(`${FILE}.lock`, JSON.stringify({ pid: process.pid, token: 'live' }))

    await expect(writeConfigObject({ unsafe: true }, {
      filePath: FILE,
      lockTimeoutMs: 20,
      staleLockMs: 60_000,
    })).rejects.toBeInstanceOf(ConfigLockTimeoutError)
    expect(readdirSync(DIR)).toEqual(['config.json.lock'])
  })

  it('rejects malformed or non-object config content', async () => {
    writeFileSync(FILE, '[1,2,3]')
    await expect(readConfigObject({ filePath: FILE })).rejects.toThrow('must contain a JSON object')

    writeFileSync(FILE, '{broken')
    await expect(readConfigObject({ filePath: FILE })).rejects.toBeInstanceOf(SyntaxError)
  })
})
